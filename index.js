// ============================================================
//  GOLD (XAUUSD) REALTIME SIGNAL SERVER — v3.2 (Syntax Fixed)
// ============================================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const TI = require("technicalindicators");

const app = express();
app.use(cors());
app.use(express.static("public"));

// SECURITY CHECK
if (!process.env.TD_KEY || !process.env.TG_TOKEN || !process.env.TG_CHAT) {
  console.error("FATAL: Missing environment variables.");
  process.exit(1);
}

// CONFIG
const CONFIG = {
  SYMBOL: "XAU/USD",
  INTERVAL: process.env.INTERVAL || "5min",
  SPREAD: 0.30,
  CONTRACT_SIZE: 100,
  ACCOUNT_BALANCE: 1000,
  RISK_PERCENT: 1.0,
  ATR_SL: 2.0,
  ATR_TP: 5.0,
  MIN_RR: 2.5,
  MIN_CONFIRM: 12,
  MAX_OPPOSITE: 3,
  MAX_TRADES_DAY: 3,
  POLL_SECONDS: 300,
  STALE_THRESHOLD_MIN: 10,
  ENABLE_MTF: true,
  MTF_TIMEFRAMES: ['15min', '1h'], 
  TWELVE_DATA_KEY: process.env.TD_KEY,
  TELEGRAM_TOKEN: process.env.TG_TOKEN,
  TELEGRAM_CHAT: process.env.TG_CHAT,
};

// STATE MANAGEMENT
const STATE_FILE = process.env.STATE_PATH || path.join(__dirname, "bot_state.json");
let botState = { dayTrades: 0, dayKey: "", lastAlertKey: null, lastAlertBar: null, activeTrade: null };
let isSavingState = false;

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      botState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      console.log("State loaded:", STATE_FILE);
    }
  } catch (e) {
    console.log("State load error:", e.message);
  }
}

async function saveState() {
  if (isSavingState) return; 
  isSavingState = true;
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await fsp.writeFile(STATE_FILE, JSON.stringify(botState, null, 2));
  } catch (e) {
    console.log("State save error:", e.message);
  } finally {
    isSavingState = false;
  }
}

let lastSignal = { signal: "NONE", time: null, reason: "Booting...", isDataFresh: false };
let candles = [];
let mtfCache = {}; 
let consecutiveErrors = 0;
let lastFetchTime = null;
let isFetching = false;

loadState();

// AUTO TRADE TRACKER
async function monitorActiveTrade() {
  if (!botState.activeTrade) return;
  if (candles.length < 2) return; 

  const trade = botState.activeTrade;
  const tradeAge = Date.now() - new Date(trade.time).getTime();
  if (tradeAge > 24 * 60 * 60 * 1000) { 
    console.log("Trade expired (24h limit). Clearing active trade.");
    botState.activeTrade = null;
    await saveState();
    return;
  }

  const lastClosed = candles[candles.length - 2];
  if (!lastClosed) return;

  let result = null;

  if (trade.type === 'BUY') {
    if (lastClosed.low <= trade.sl) result = 'SL';
    else if (lastClosed.high >= trade.tp) result = 'TP';
  } else if (trade.type === 'SELL') {
    if (lastClosed.high >= trade.sl) result = 'SL';
    else if (lastClosed.low <= trade.tp) result = 'TP';
  }

  if (result) {
    const isWin = result === 'TP';
    const emoji = isWin ? '✅' : '❌';
    const statusText = isWin ? 'TARGET HIT (WIN)' : 'STOP LOSS HIT (LOSS)';
    
    const msg = 
      emoji + ' <b>TRADE UPDATE: ' + trade.type + ' CLOSED</b>\n\n' +
      ' Result: <b>' + statusText + '</b>\n' +
      '💰 Entry: <b>' + trade.entry + '</b>\n' +
      '🛑 SL: ' + trade.sl + ' | 🎯 TP: ' + trade.tp + '\n\n' +
      ' Closed at: ' + lastClosed.time + '\n' +
      '📊 <i>Update your trading journal!</i>';

    await sendTelegramRaw(msg);
    console.log('Trade Closed:', result, 'for', trade.type, '@', trade.entry);

    botState.activeTrade = null;
    await saveState();
  }
}

// INDICATOR HELPERS
function calcEMA(values, period) {
  const result = TI.EMA.calculate({ period, values });
  return result[result.length - 1] ?? values[values.length - 1];
}

function calcRSI(values, period = 14) {
  const result = TI.RSI.calculate({ period, values });
  return result[result.length - 1] ?? 50;
}

function calcATR(candles, period = 14) {
  const high = candles.map(c => c.high);
  const low = candles.map(c => c.low);
  const close = candles.map(c => c.close);
  const result = TI.ATR.calculate({ high, low, close, period });
  return result[result.length - 1] ?? 0;
}

function calcMACD(values) {
  const result = TI.MACD.calculate({
    values, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
    SimpleMAOscillator: false, SimpleMASignal: false,
  });
  const last = result[result.length - 1];
  return last ? { macd: last.MACD, signal: last.signal } : { macd: 0, signal: 0 };
}

function calcStochK(candles, period = 14) {
  const high = candles.map(c => c.high);
  const low = candles.map(c => c.low);
  const close = candles.map(c => c.close);
  const result = TI.Stochastic.calculate({ high, low, close, period, signalPeriod: 3 });
  const last = result[result.length - 1];
  return last ? last.k : 50;
}

function calcDMI(candles, period = 14) {
  const high = candles.map(c => c.high);
  const low = candles.map(c => c.low);
  const close = candles.map(c => c.close);
  const result = TI.ADX.calculate({ high, low, close, period });
  const last = result[result.length - 1];
  return last ? { adx: last.adx, diPlus: last.plusDI, diMinus: last.minusDI } : { adx: 0, diPlus: 0, diMinus: 0 };
}

// MULTI-TIMEFRAME ANALYSIS
async function fetchMTFData(timeframe) {
  try {
    const now = Date.now();
    const cacheDuration = timeframe === '15min' ? 15 * 60 * 1000 : 60 * 60 * 1000;
    
    if (mtfCache[timeframe] && (now - mtfCache[timeframe].lastFetch < cacheDuration)) {
      return mtfCache[timeframe].data;
    }

    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(CONFIG.SYMBOL)}&interval=${timeframe}&outputsize=100&apikey=${CONFIG.TWELVE_DATA_KEY}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    
    if (!data.values) return null;
    
    const tfCandles = data.values.reverse().map(v => ({
      time: v.datetime, open: parseFloat(v.open), high: parseFloat(v.high),
      low: parseFloat(v.low), close: parseFloat(v.close),
    }));
    
    if (tfCandles.length < 50) return null;
    
    const closedCandles = tfCandles.slice(0, -1);
    const closes = closedCandles.map(c => c.close);
    const lastClosed = tfCandles[tfCandles.length - 2];
    
    const e9 = calcEMA(closes, 9);
    const e21 = calcEMA(closes, 21);
    const macd = calcMACD(closes);
    const rsi = calcRSI(closes, 14);
    
    let score = 0;
    if (lastClosed.close > e9 && e9 > e21) score += 3;
    if (macd.macd > macd.signal) score += 2;
    if (rsi < 40) score += 2;
    if (rsi > 60) score -= 2;
    
    const signal = score >= 4 ? 'BUY' : score <= -2 ? 'SELL' : 'NEUTRAL';
    const result = { timeframe, signal, score, rsi: rsi.toFixed(1), price: lastClosed.close.toFixed(2) };
    
    mtfCache[timeframe] = { data: result, lastFetch: now };
    return result;
  } catch (e) {
    console.log(`MTF Error (${timeframe}):`, e.message);
    return mtfCache[timeframe]?.data || null;
  }
}

async function getMultiTimeframeConfirmation() {
  if (!CONFIG.ENABLE_MTF) return null;
  const results = [];
  for (const tf of CONFIG.MTF_TIMEFRAMES) {
    const analysis = await fetchMTFData(tf);
    if (analysis) results.push(analysis);
  }
  if (results.length === 0) return null;
  
  const buyCount = results.filter(r => r.signal === 'BUY').length;
  const sellCount = results.filter(r => r.signal === 'SELL').length;
  const total = results.length;
  
  let mtfSignal = 'NEUTRAL', mtfConfidence = 0;
  if (buyCount >= 2 || (buyCount >= 1 && sellCount === 0 && total >= 2)) { 
    mtfSignal = 'BUY'; 
    mtfConfidence = (buyCount / total) * 100; 
  } else if (sellCount >= 2 || (sellCount >= 1 && buyCount === 0 && total >= 2)) { 
    mtfSignal = 'SELL'; 
    mtfConfidence = (sellCount / total) * 100; 
  }
  
  return { signal: mtfSignal, confidence: mtfConfidence.toFixed(0), details: results };
}

// SESSION & NEWS FILTERS
function goodSession() {
  const now = new Date();
  const nyHour = parseInt(now.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  const london = nyHour >= 3 && nyHour < 7;
  const ny = nyHour >= 8 && nyHour < 17;
  const overlap = nyHour >= 8 && nyHour < 12;
  return { active: london || ny, overlap, name: overlap ? "LONDON-NY OVERLAP" : london ? "LONDON" : ny ? "NY" : "CLOSED" };
}

function isNewsTime() {
  const now = new Date();
  const nyHour = parseInt(now.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  const nyMin = parseInt(now.toLocaleString("en-US", { timeZone: "America/New_York", minute: "numeric" }));
  const totalMin = nyHour * 60 + nyMin;
  const newsWindows = [[495, 525], [600, 630], [840, 870]];
  return newsWindows.some(([s, e]) => totalMin >= s && totalMin <= e);
}

// CORE ANALYSIS ENGINE
async function analyze() {
  if (candles.length < 60) {
    lastSignal = { signal: "NONE", reason: "Collecting data...", time: new Date().toISOString(), isDataFresh: true };
    return;
  }

  await monitorActiveTrade();

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  
  const lastClosed = candles[candles.length - 2];
  const prevClosed = candles[candles.length - 3];
  const currentCandle = candles[candles.length - 1];

  const e9 = calcEMA(closes, 9);
  const e21 = calcEMA(closes, 21);
  const e50 = calcEMA(closes, 50);
  const r = calcRSI(closes, 14);
  const a = calcATR(candles, 14);
  const m = calcMACD(closes);
  const s = calcStochK(candles);
  const d = calcDMI(candles);

  const sortedLows = [...lows.slice(-50, -1)].sort((a, b) => a - b);
  const sortedHighs = [...highs.slice(-50, -1)].sort((a, b) => b - a);
  const support = sortedLows[Math.floor(sortedLows.length * 0.1)]; 
  const resistance = sortedHighs[Math.floor(sortedHighs.length * 0.1)];

  const body = Math.abs(lastClosed.close - lastClosed.open);
  const prevBody = Math.abs(prevClosed.close - prevClosed.open);
  const bullEngulf = lastClosed.close > lastClosed.open && prevClosed.close < prevClosed.open && lastClosed.open <= prevClosed.close && lastClosed.close >= prevClosed.open && body > prevBody;
  const bearEngulf = lastClosed.close < lastClosed.open && prevClosed.close > prevClosed.open && lastClosed.open >= prevClosed.close && lastClosed.close <= prevClosed.open && body > prevBody;

  const wickLow = lastClosed.close > lastClosed.open ? lastClosed.open - lastClosed.low : lastClosed.close - lastClosed.low;
  const wickHigh = lastClosed.close > lastClosed.open ? lastClosed.high - lastClosed.close : lastClosed.high - lastClosed.open;
  const bullPin = wickLow > body * 2 && wickHigh < body * 0.5;
  const bearPin = wickHigh > body * 2 && wickLow < body * 0.5;

  let bullishStructure = false, bearishStructure = false;
  if (candles.length >= 10) {
    let swingHighs = [];
    let swingLows = [];
    
    for (let i = 2; i < candles.length - 2; i++) {
      if (candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
          candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high) {
        swingHighs.push(candles[i].high);
      }
      if (candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
          candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low) {
        swingLows.push(candles[i].low);
      }
    }

    if (swingHighs.length >= 2 && swingLows.length >= 2) {
      const lastSH = swingHighs[swingHighs.length - 1];
      const prevSH = swingHighs[swingHighs.length - 2];
      const lastSL = swingLows[swingLows.length - 1];
      const prevSL = swingLows[swingLows.length - 2];

      if (lastSH > prevSH && lastSL > prevSL) bullishStructure = true;
      if (lastSH < prevSH && lastSL < prevSL) bearishStructure = true;
    }
  }

  const recentMaxHigh = Math.max(...highs.slice(-6, -1));
  const recentMinLow = Math.min(...lows.slice(-6, -1));
  const strongBody = body > a * 0.6;
  const bullishBreakout = lastClosed.close > recentMaxHigh && strongBody;
  const bearishBreakout = lastClosed.close < recentMinLow && strongBody;

  const strongBull = lastClosed.close > e9 && e9 > e21 && e21 > e50;
  const strongBear = lastClosed.close < e9 && e9 < e21 && e21 < e50;

  const session = goodSession();
  const newsPause = isNewsTime();

  let buy = 0, sell = 0;
  
  if (strongBull) buy += 3;
  if (bullishStructure) buy += 3;
  if (bullishBreakout) buy += 3;
  if (bullEngulf) buy += 3;
  if (bullPin) buy += 2;
  if (lastClosed.close > e21 && e21 > e50) buy += 2;
  if (m.macd > m.signal) buy += 2;
  if (d.adx > 25 && d.diPlus > d.diMinus) buy += 3;
  if (s < 20) buy += 2;
  if (lastClosed.low <= support + a && lastClosed.close > support) buy += 2;
  if (session.overlap) buy += 1;
  if (r < 45) buy += 1;

  if (strongBear) sell += 3;
  if (bearishStructure) sell += 3;
  if (bearishBreakout) sell += 3;
  if (bearEngulf) sell += 3;
  if (bearPin) sell += 2;
  if (lastClosed.close < e21 && e21 < e50) sell += 2;
  if (m.macd < m.signal) sell += 2;
  if (d.adx > 25 && d.diMinus > d.diPlus) sell += 3;
  if (s > 80) sell += 2;
  if (lastClosed.high >= resistance - a && lastClosed.close < resistance) sell += 2;
  if (session.overlap) sell += 1;
  if (r > 55) sell += 1;

  let mtfBonus = 0;
  let mtfDetails = null;
  if (CONFIG.ENABLE_MTF) {
    mtfDetails = await getMultiTimeframeConfirmation();
    if (mtfDetails) {
      if (mtfDetails.signal === 'BUY' && buy > sell) { mtfBonus = 3; buy += mtfBonus; }
      else if (mtfDetails.signal === 'SELL' && sell > buy) { mtfBonus = 3; sell += mtfBonus; }
    }
  }

  const candleTimeStr = lastClosed.time.replace(' ', 'T') + 'Z';
  const candleDateUTC = new Date(candleTimeStr);
  const todayKey = new Intl.DateTimeFormat('en-CA', { 
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' 
  }).format(candleDateUTC);

  if (todayKey !== botState.dayKey) {
    botState.dayKey = todayKey;
    botState.dayTrades = 0;
    await saveState();
  }

  const canTrade = session.active && !newsPause && botState.dayTrades < CONFIG.MAX_TRADES_DAY;
  const slDist = a * CONFIG.ATR_SL;
  const tpDist = Math.max(a * CONFIG.ATR_TP, slDist * CONFIG.MIN_RR);
  const riskMoney = CONFIG.ACCOUNT_BALANCE * (CONFIG.RISK_PERCENT / 100);

  let lot = slDist > 0 ? riskMoney / (slDist * CONFIG.CONTRACT_SIZE) : 0.01;
  lot = Math.max(0.01, Math.min(5.0, Math.round(lot * 100) / 100));

  let sig = "NONE", entry = lastClosed.close, sl = null, tp = null;

  if (buy >= CONFIG.MIN_CONFIRM && sell <= CONFIG.MAX_OPPOSITE && canTrade) {
    sig = "BUY";
    entry = lastClosed.close + CONFIG.SPREAD;
    sl = entry - slDist;
    tp = entry + tpDist;
  } else if (sell >= CONFIG.MIN_CONFIRM && buy <= CONFIG.MAX_OPPOSITE && canTrade) {
    sig = "SELL";
    entry = lastClosed.close - CONFIG.SPREAD;
    sl = entry + slDist;
    tp = entry - tpDist;
  }

  const maxPossibleScore = 26 + (CONFIG.ENABLE_MTF ? 3 : 0);
  const actualScore = Math.max(buy, sell);
  const confidence = Math.min(100, Math.round((actualScore / maxPossibleScore) * 100));

  const nowISO = new Date().toISOString();
  lastSignal = {
    signal: sig, time: nowISO, barTime: lastClosed.time, price: currentCandle.close,
    entry: sig !== "NONE" ? +entry.toFixed(2) : null,
    stopLoss: sl ? +sl.toFixed(2) : null,
    takeProfit: tp ? +tp.toFixed(2) : null,
    lotSize: sig !== "NONE" ? lot : null,
    buyScore: buy, sellScore: sell, confidence: confidence,
    mtfConfirmation: mtfDetails, session: session.name, newsPaused: newsPause,
    tradesToday: botState.dayTrades, isDataFresh: true,
    activeTrade: botState.activeTrade, 
    indicators: {
      ema9: +e9.toFixed(2), ema21: +e21.toFixed(2), ema50: +e50.toFixed(2),
      rsi: +r.toFixed(1), adx: +d.adx.toFixed(1),
      atr: +a.toFixed(2), support: +support.toFixed(2), resistance: +resistance.toFixed(2),
      spread: CONFIG.SPREAD,
    },
    note: sig === "NONE"
      ? (newsPause ? "High-Impact News Time (Paused)" : !session.active ? "Session closed" : botState.dayTrades >= CONFIG.MAX_TRADES_DAY ? "Daily trade limit reached" : "No high-confidence setup — waiting")
      : `Strong confirmed setup (${confidence}% confidence)`,
  };

  const alertKey = `${sig}-${lastClosed.time}`;
  if (sig !== "NONE" && alertKey !== botState.lastAlertKey && lastClosed.time !== botState.lastAlertBar) {
    botState.dayTrades++;
    botState.lastAlertKey = alertKey;
    botState.lastAlertBar = lastClosed.time;
    
    botState.activeTrade = {
      type: sig,
      entry: entry,
      sl: sl,
      tp: tp,
      time: nowISO
    };
    
    await saveState();
    lastSignal.tradesToday = botState.dayTrades;
    await sendTelegram(lastSignal);
    console.log(`ALERT SENT [${nowISO}] ${sig} | Confidence: ${confidence}% | price ${lastClosed.close}`);
  } else {
    console.log(`[${nowISO}] scan: buy ${buy} sell ${sell} | confidence ${confidence}% | no new alert`);
  }
}

// DATA FETCHING & TELEGRAM
async function fetchData() {
  if (isFetching) { console.log("Fetch skipped (already in progress)..."); return; }
  isFetching = true;
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(CONFIG.SYMBOL)}&interval=${CONFIG.INTERVAL}&outputsize=200&apikey=${CONFIG.TWELVE_DATA_KEY}`;
    const { data } = await axios.get(url, { timeout: 15000 });

    if (!data.values) {
      consecutiveErrors++;
      if (consecutiveErrors >= 5) { await sendTelegramRaw("Data fetch failing repeatedly. Check API Key."); consecutiveErrors = 0; }
      if (lastSignal) lastSignal.isDataFresh = false;
      return;
    }
    consecutiveErrors = 0;
    lastFetchTime = new Date();
    candles = data.values.reverse().map(v => ({
      time: v.datetime, open: parseFloat(v.open), high: parseFloat(v.high),
      low: parseFloat(v.low), close: parseFloat(v.close),
    }));
    await analyze();
  } catch (e) {
    consecutiveErrors++;
    if (lastSignal) lastSignal.isDataFresh = false;
    console.error("Fetch Error:", e.message);
  } finally {
    isFetching = false;
    setTimeout(fetchData, CONFIG.POLL_SECONDS * 1000);
  }
}

setInterval(() => {
  if (lastFetchTime) {
    const ageMin = (Date.now() - lastFetchTime.getTime()) / 60000;
    if (ageMin > CONFIG.STALE_THRESHOLD_MIN && lastSignal.isDataFresh) {
      lastSignal.isDataFresh = false;
      console.log("Data marked stale");
    }
  }
}, 30000);

async function sendTelegramRaw(text) {
  if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT) return;
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM_CHAT, text, parse_mode: "HTML",
    }, { timeout: 5000 });
  } catch (e) { console.log("TG error:", e.message); }
}

async function sendTelegram(sig) {
  const emoji = sig.signal === "BUY" ? "🟢" : "🔴";
  const newsWarning = sig.newsPaused ? "\n⚠️ <b>NOTE:</b> Signal near news time!" : "";
  
  let mtfText = "";
  if (sig.mtfConfirmation) {
    const mtf = sig.mtfConfirmation;
    mtfText = "\n📊 <b>Multi-Timeframe:</b>\n";
    mtf.details.forEach(d => {
      const icon = d.signal === 'BUY' ? '🟢' : d.signal === 'SELL' ? '🔴' : '⚪';
      mtfText += `${icon} ${d.timeframe}: ${d.signal} (score: ${d.score})\n`;
    });
    mtfText += `✨ MTF Confidence: ${mtf.confidence}%`;
  }

  const rr = Math.abs(sig.takeProfit - sig.entry) / Math.abs(sig.entry - sig.stopLoss);

  const msg =
    `${emoji} <b>GOLD ${sig.signal}</b> ⭐${sig.confidence}%\n\n` +
    `📌 Entry: <b>${sig.entry}</b>\n` +
    `🛑 SL: <b>${sig.stopLoss}</b>\n` +
    `🎯 TP: <b>${sig.takeProfit}</b>\n` +
    ` Lot: <b>${sig.lotSize}</b>\n` +
    `📈 R:R = <b>1:${rr.toFixed(1)}</b>\n\n` +
    `🕐 Session: ${sig.session}\n` +
    `📊 Score → Buy: ${sig.buyScore} | Sell: ${sig.sellScore}\n` +
    `📈 RSI: ${sig.indicators.rsi} | ADX: ${sig.indicators.adx}\n` +
    `${mtfText}\n` +
    `${newsWarning}\n` +
    `⚠️ <i>Trading involves risk. Manage your own risk.</i>`;

  await sendTelegramRaw(msg);
}

// ROUTES
app.get("/", (req, res) => {
  res.status(200).json({ 
    status: "healthy",
    service: "Gold Signal Server v3.2",
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    uptime: process.uptime(),
    candlesLoaded: candles.length,
    isDataFresh: lastSignal.isDataFresh,
    state: botState,
    isFetching: isFetching
  });
});

app.get("/signal", (req, res) => res.json(lastSignal));

// SERVER START
const PORT = parseInt(process.env.PORT) || 3000;

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Server running on port ${PORT} — polling every ${CONFIG.POLL_SECONDS}s`);
  console.log(`📊 Interval: ${CONFIG.INTERVAL} | MTF: ${CONFIG.ENABLE_MTF ? 'ON' : 'OFF'} | Auto-Tracker: ENABLED`);
  
  if (process.env.DISABLE_BOOT_MSG !== "true") {
    await sendTelegramRaw("✅ <b>Gold Signal Server v3.2 (Syntax Fixed)</b> is LIVE!");
  }
  fetchData();
});

process.on("unhandledRejection", (err) => { 
  console.error("❌ Unhandled rejection:", err); 
  process.exit(1); 
});
process.on("uncaughtException", (err) => { 
  console.error("❌ Uncaught exception:", err); 
  process.exit(1); 
});
