// server/server.js
// Node.js WebSocket backend for live signal generation.
// - Serves static public/ if needed
// - Opens websockets to clients, broadcasts signals
// - Example integration: Binance public trade stream for crypto
// - Replace SAMPLE_TICKER_CONNECTORS with your broker tick feed integration (Quotex/API)

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const { SMA, RSI, EMA } = require('technicalindicators');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(express.static('public')); // serve frontend if you want

// Config: comma-separated WATCH symbols. For Forex use pair codes matching your feed.
const WATCH = (process.env.WATCH_SYMBOLS || 'BTCUSDT,EURUSD,USDJPY').split(',').map(s => s.trim().toUpperCase());

// Storage for simple bars (1s resolution)
const bars = {}; // bars['BTCUSDT'] = [{time, open, high, low, close, volume},...]

// Helper broadcast
function broadcast(msg){
  const raw = JSON.stringify(msg);
  wss.clients.forEach(c => {
    if(c.readyState === WebSocket.OPEN) c.send(raw);
  });
}

// --- Example connector for Binance trades (crypto) ---
// This is optional: you can remove if you will provide broker-specific feed
const WebSocketClient = require('ws');
const binanceSockets = {}; // symbol -> ws

function startBinanceSymbol(sym){
  try{
    const stream = sym.toLowerCase() + '@trade';
    const url = `wss://stream.binance.com:9443/ws/${stream}`;
    const ws = new WebSocketClient(url);
    ws.on('open', ()=> console.log('Binance stream open for', sym));
    ws.on('message', data => {
      try{
        const d = JSON.parse(data);
        const price = parseFloat(d.p);
        const qty = parseFloat(d.q);
        const ts = Math.floor(d.T/1000); // seconds
        appendTick(sym, price, qty, ts);
      }catch(e){ /* ignore parse errors */ }
    });
    ws.on('error', e => { console.warn('Binance ws error', e.message); ws.terminate(); setTimeout(()=> startBinanceSymbol(sym),5000); });
    ws.on('close', ()=> { console.log('Binance closed for', sym); setTimeout(()=> startBinanceSymbol(sym),5000); });
    binanceSockets[sym] = ws;
  }catch(e){ console.warn('startBinanceSymbol err', e.message); }
}

// Append tick to per-second bar
function appendTick(sym, price, qty, ts){
  bars[sym] = bars[sym] || [];
  const arr = bars[sym];
  const last = arr[arr.length-1];
  if(!last || last.time !== ts){
    const newBar = { time: ts, open: price, high: price, low: price, close: price, volume: qty };
    arr.push(newBar);
    if(arr.length > 600) arr.shift();
  } else {
    last.close = price;
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.volume += qty;
  }
}

// Placeholder for Forex/broker feed integration
// Add your broker API / WebSocket logic here and push ticks using appendTick(sym, price, qty, ts)
// Example: OANDA streaming, FXCM ws, or your broker's provided stream

// If running demo/sim mode (no external tick feed), we can simulate ticks:
function simulateTick(sym){
  bars[sym] = bars[sym] || [];
  const arr = bars[sym];
  // generate pseudo price
  let base = sym.includes('BTC') ? 110000 : (sym.startsWith('EUR') ? 1.09 : 1.00);
  const rand = (Math.random()-0.5) * (sym.includes('BTC') ? 200 : 0.0012);
  const price = +(base + rand).toFixed(sym.includes('BTC') ? 0 : 4);
  const ts = Math.floor(Date.now()/1000);
  const qty = Math.random()*5;
  appendTick(sym, price, qty, ts);
}

// --- Signal engine (multi-layer heuristic / extendable) ---
function computeSignal(sym, marketType = 'binary'){
  const series = bars[sym] || [];
  if(series.length < 30) return null;
  const closes = series.map(b => b.close).slice(-120);
  // compute indicators safely
  let smaShort, smaLong, rsi;
  try{
    smaShort = SMA.calculate({ period: 5, values: closes.slice(-50) }).slice(-1)[0];
    smaLong = SMA.calculate({ period: 20, values: closes.slice(-80) }).slice(-1)[0];
    rsi = RSI.calculate({ period: 14, values: closes.slice(-50) }).slice(-1)[0];
  }catch(e){}
  // volume heuristic
  const vols = series.map(b => b.volume).slice(-50);
  const avgVol = vols.reduce((a,b)=>a+b,0) / Math.max(1, vols.length);
  const lastVol = vols[vols.length-1] || 0;
  const volSpike = lastVol > avgVol * 2.0;

  // wick heuristic
  const lastBar = series[series.length-1];
  const prevBar = series[series.length-2] || lastBar;
  const wickUp = lastBar.high - Math.max(lastBar.open, lastBar.close);
  const wickDown = Math.min(lastBar.open, lastBar.close) - lastBar.low;

  // scoring
  let score = 50;
  if(smaShort && smaLong){
    if(smaShort > smaLong) score += 10; else score -= 10;
  }
  if(typeof rsi === 'number'){
    if(rsi < 35) score += 12;
    if(rsi > 65) score -= 12;
  }
  if(volSpike) score += 8;
  if(wickDown > wickUp) score += 6;
  if(wickUp > wickDown) score -= 6;

  // SMC/ICT/OB/FVG placeholders:
  // Here you can add stronger heuristics:
  // - Detect order blocks: find large directional candle and price retest zone
  // - Detect FVG: unfilled gaps between candles
  // - Multi-timeframe alignment: compute above on aggregated M1/M5/M15 (requires built bars)
  // - Psychology filters (round numbers, holiday hours)
  // For now we leave placeholders for you to implement your rules.

  score = Math.max(10, Math.min(99, Math.round(score)));

  // decide direction
  const direction = (score >= 60) ? 'CALL' : (score <= 40 ? 'PUT' : (smaShort > smaLong ? 'CALL' : 'PUT'));

  // entry estimate (approx)
  const lastPrice = lastBar.close;
  const entryLow = (lastPrice * 0.999).toFixed(sym.includes('BTC') ? 0 : 4);
  const entryHigh = (lastPrice * 1.001).toFixed(sym.includes('BTC') ? 0 : 4);

  return {
    market: marketType,
    symbol: sym,
    direction,
    entry: `${entryLow} – ${entryHigh}`,
    confidence: score,
    mtg: Math.random() > 0.2,
    notes: 'Multi-check heuristics (SMA/RSI/Vol/Wick). Add broker feed for true confirmations.',
    time: new Date().toISOString()
  };
}

// Periodic generator loop: every 5s compute signals for watched pairs
setInterval(() => {
  // simulate ticks if no real feed present (demo mode)
  WATCH.forEach(sym => {
    // If you have a real feed, do NOT simulate
    if(!bars[sym] || bars[sym].length < 50){
      simulateTick(sym);
    }
    const sig = computeSignal(sym, 'binary');
    if(sig){
      broadcast({ type: 'signal', data: sig });
      broadcast({ type: 'log', data: `Signal(${sym}) ${sig.direction} conf:${sig.confidence}` });
      console.log('Emitted signal', sig.symbol, sig.direction, sig.confidence);
    }
  });
}, 5000);

// WebSocket client handling for frontends
wss.on('connection', ws => {
  console.log('Client connected');
  ws.send(JSON.stringify({ type: 'info', data: 'welcome' }));
  ws.on('message', message => {
    try{
      const m = JSON.parse(message.toString());
      if(m.type === 'reqSignalNow'){
        // client requests an on-demand signal
        const symbol = (m.pair && m.pair.toUpperCase()) || WATCH[0];
        const market = m.market || 'binary';
        // ensure at least some bars exist
        if(!bars[symbol] || bars[symbol].length < 10){
          // simulate small ticks to create bars
          simulateTick(symbol);
        }
        const sig = computeSignal(symbol, market);
        if(sig) ws.send(JSON.stringify({ type: 'signal', data: sig }));
      }
    }catch(e){ /* ignore parse errors */ }
  });
});

// Start Binance connectors optionally (only for crypto)
// Start only symbols that look like Binance symbols (e.g., end with USDT)
WATCH.forEach(sym => {
  if(sym.endsWith('USDT')) {
    startBinanceSymbol(sym);
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log('Watching symbols:', WATCH.join(', '));
});
