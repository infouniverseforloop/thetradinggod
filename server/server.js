// server.js (paste / replace your current server.js)
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const { SMA, RSI } = require('technicalindicators');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const WATCH_SYMBOLS = (process.env.WATCH_SYMBOLS || 'BTCUSDT,EURUSD,USDJPY').split(',').map(s=>s.trim().toUpperCase());

// simple in-memory storage
const bars = {}; // bars[symbol] = [{time,open,high,low,close,volume}, ...]  (1s)
const history = []; // last signals (for UI/backtest), keep last 200

// http endpoints
app.use(express.static('public'));
app.get('/pairs', (req, res) => {
  // return active watch list and some metadata (OTC vs FX guess)
  const pairs = WATCH_SYMBOLS.map(p => {
    return {
      symbol: p,
      type: p.endsWith('USDT') ? 'crypto' : (p.includes('/') || p.length===6 ? 'forex' : 'otc'),
      available: true
    };
  });
  res.json({ ok:true, pairs, server_time: new Date().toISOString() });
});
app.get('/signals/history', (req,res) => {
  res.json({ ok:true, history });
});

// WebSocket broadcast helper
function broadcast(obj){
  const raw = JSON.stringify(obj);
  wss.clients.forEach(c => { if(c.readyState === WebSocket.OPEN) c.send(raw); });
}

// Append tick into per-second OHLC
function appendTick(sym, price, qty, tsSec){
  bars[sym] = bars[sym] || [];
  const arr = bars[sym];
  const last = arr[arr.length-1];
  if(!last || last.time !== tsSec){
    const newBar = { time: tsSec, open: price, high: price, low: price, close: price, volume: qty };
    arr.push(newBar);
    if(arr.length > 3600) arr.shift();
  } else {
    last.close = price;
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.volume += qty;
  }
}

// Fallback demo tick generator (only if no real feed)
function simulateTick(sym){
  bars[sym] = bars[sym] || [];
  const arr = bars[sym];
  const base = sym.includes('BTC') ? 110000 : (sym.startsWith('EUR') ? 1.09 : 1.0);
  const noise = (Math.random()-0.5) * (sym.includes('BTC') ? 200 : 0.0012);
  const price = +(base + noise).toFixed(sym.includes('BTC') ? 0 : 4);
  const qty = Math.random() * (sym.includes('BTC') ? 1 : 100);
  appendTick(sym, price, qty, Math.floor(Date.now()/1000));
}

// Aggregate bars to timeframe (seconds -> M1, M5)
function aggregateBars(sym, secondsPerBar){
  const arr = bars[sym] || [];
  if(!arr.length) return [];
  // compress second bars into timeframe bars
  const res = [];
  let bucket = null;
  for(const b of arr){
    const t = Math.floor(b.time / secondsPerBar) * secondsPerBar;
    if(!bucket || bucket.time !== t){
      bucket = { time:t, open:b.open, high:b.high, low:b.low, close:b.close, volume:b.volume };
      res.push(bucket);
    } else {
      bucket.high = Math.max(bucket.high, b.high);
      bucket.low = Math.min(bucket.low, b.low);
      bucket.close = b.close;
      bucket.volume += b.volume;
    }
  }
  return res;
}

// Simple OB/FVG placeholder functions (you will replace with your exact logic)
function detectOrderBlock(sym){
  // placeholder: return true if last big candle and retest pattern — you must implement real logic
  return false;
}
function detectFVG(sym){
  // placeholder
  return false;
}

// multi-timeframe score + signal maker
function computeSignal(sym, market='binary'){
  const s = sym.toUpperCase();
  const secSeries = bars[s] || [];
  if(secSeries.length < 30) return null;

  // Build M1 and M5
  const m1 = aggregateBars(s, 60); // 60s bars
  const m5 = aggregateBars(s, 300); // 300s bars

  // Need enough bars
  if(m1.length < 10) return null;

  // indicators on M1
  const closesM1 = m1.map(b => b.close).slice(-80);
  const closesM5 = m5.map(b => b.close).slice(-80);

  let smaShortM1, smaLongM1, rsiM1;
  try {
    smaShortM1 = SMA.calculate({ period:5, values: closesM1 }).slice(-1)[0];
    smaLongM1  = SMA.calculate({ period:20, values: closesM1 }).slice(-1)[0];
    rsiM1 = RSI.calculate({ period:14, values: closesM1 }).slice(-1)[0];
  } catch(e){}

  // M5 confirm
  let smaShortM5, smaLongM5;
  try {
    smaShortM5 = SMA.calculate({ period:5, values: closesM5 }).slice(-1)[0];
    smaLongM5  = SMA.calculate({ period:20, values: closesM5 }).slice(-1)[0];
  } catch(e){}

  // volume spike on sec series (compare last 20s avg)
  const vols = secSeries.slice(-120).map(b => b.volume);
  const avgVol = vols.slice(-60).reduce((a,b)=>a+b,0)/Math.max(1, Math.min(60, vols.slice(-60).length));
  const lastVol = vols[vols.length-1] || 0;
  const volSpike = lastVol > avgVol * 2.2;

  // wick heuristic using last 2 M1 bars
  const lastM1 = m1[m1.length-1];
  const prevM1 = m1[m1.length-2] || lastM1;
  const wickUp = lastM1.high - Math.max(lastM1.open, lastM1.close);
  const wickDown = Math.min(lastM1.open, lastM1.close) - lastM1.low;

  // scoring: base 50, add multi-TF confirmations
  let score = 50;
  if(smaShortM1 && smaLongM1) score += (smaShortM1 > smaLongM1 ? 8 : -8);
  if(smaShortM5 && smaLongM5) score += (smaShortM5 > smaLongM5 ? 6 : -6);
  if(typeof rsiM1 === 'number'){
    if(rsiM1 < 35) score += 10;
    if(rsiM1 > 65) score -= 10;
  }
  if(volSpike) score += 8;
  if(wickDown > wickUp) score += 6;
  if(wickUp > wickDown) score -= 6;

  // Add OB/FVG strong boost if detected across M1/M5 (placeholder)
  if(detectOrderBlock(s)) score += 10;
  if(detectFVG(s)) score += 8;

  // Round number proximity boost (if price close to .000 or 00)
  const p = lastM1.close;
  const roundDist = Math.abs(Math.round(p) - p);
  if(roundDist < (p * 0.0005)) score += 4;

  score = Math.max(10, Math.min(99, Math.round(score)));

  // direction: combine M1/M5 bias
  const direction = (score >= 60) ? 'CALL' : (score <= 40 ? 'PUT' : (smaShortM1 > smaLongM1 ? 'CALL' : 'PUT'));

  // expiry calculation: for binary assume 60s from server time
  const now = new Date();
  const expirySeconds = (process.env.BINARY_EXPIRY_SECONDS ? parseInt(process.env.BINARY_EXPIRY_SECONDS) : 60);
  const expiryAt = new Date(now.getTime() + expirySeconds * 1000);

  const signal = {
    market,
    symbol: s,
    direction,
    entry: `${(p*0.999).toFixed(s.includes('BTC')?0:4)} – ${(p*1.001).toFixed(s.includes('BTC')?0:4)}`,
    confidence: score,
    mtg: Math.random() > 0.2,
    notes: 'Computed: M1/M5 SMA+RSI+Vol+Wick (+OB/FVG placeholders).',
    time: now.toISOString(),
    expiry_at: expiryAt.toISOString()
  };

  // push into history (keep max 500)
  history.unshift(signal);
  if(history.length > 500) history.pop();

  return signal;
}

// Broadcast periodic signals (every 5s attempt per watch symbol)
setInterval(() => {
  WATCH_SYMBOLS.forEach(sym => {
    // create bars if not present (simulate) — replace with real tick feeder
    if(!bars[sym] || bars[sym].length < 30) simulateTick(sym);

    const sig = computeSignal(sym, 'binary');
    if(sig){
      broadcast({ type:'signal', data: sig });
      broadcast({ type:'log', data: `Signal ${sig.symbol} ${sig.direction} conf:${sig.confidence}` });
    }
  });
}, 5000);

// simple WS handling for clients
wss.on('connection', ws => {
  ws.send(JSON.stringify({ type:'info', data: 'welcome', server_time: new Date().toISOString() }));
  ws.on('message', m => {
    try {
      const msg = JSON.parse(m.toString());
      if(msg.type === 'reqSignalNow'){
        const symbol = (msg.symbol || WATCH_SYMBOLS[0]).toUpperCase();
        const sig = computeSignal(symbol, msg.market || 'binary');
        if(sig) ws.send(JSON.stringify({ type:'signal', data: sig }));
      }
    } catch(e){}
  });
});

// start server
server.listen(PORT, () => console.log(`Server listening on ${PORT} — watching: ${WATCH_SYMBOLS.join(',')}`));
