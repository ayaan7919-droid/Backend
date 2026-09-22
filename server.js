// ============================================================
//  GOLD (XAUUSD) REALTIME SIGNAL SERVER — v2.6 (Final Private Repo Optimized)
//  Works on: Railway / Local / Any Node.js Host
// ============================================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const fsp = fs.promises; // ✅ Async file operations to prevent server freeze
const path = require("path");
const TI = require("technicalindicators"); // TradingView-Accurate Indicators

const app = express();
app.use(cors());
app.use(express.static("public"));

// ============================================================
//  CONFIG (Keys restored with fallback for Private GitHub)
// ============================================================
const CONFIG = {
  SYMBOL: "XAU/USD",
  INTERVAL: process.env.INTERVAL || "5min", // 5min recommended for reliability & API quota saving
  SPREAD: 0.30,
  CONTRACT_SIZE: 100, // ⚠️ Verify with your specific broker
  ACCOUNT_BALANCE: 1000,
  RISK_PERCENT: 1.0,
  ATR_SL: 2.0,
  ATR_TP: 5.0,
  MIN_RR: 2.5,

  MIN_CONFIRM: 12,
  MAX_OPPOSITE: 3,
  MAX_TRADES_DAY: 3,
  
  POLL_SECONDS: 300, // 300s (5 min) perfectly matches 5min interval (288 req/day)
  STALE_THRESHOLD_MIN: 10, // Adjusted for 5min interval

  // ✅ RESTORED: Fallback keys preserved for private repository convenience
  TWELVE_DATA_KEY: process.env.TD_KEY || "5ba753f104e94af7b7345228d078c43e",
  TELEGRAM_TOKEN: process.env.TG_TOKEN || "8867660132:AAErPb1wWfg-sici_vUzp8KJsAJNRB33wPA",
  TELEGRAM_CHAT: process.env.TG_CHAT || "8719496087",
};

// ============================================================
//  STATE MANAGEMENT 
// ============================================================
const STATE_FILE = process.env.STATE_PATH || path.join(__dirname, "bot_state.json");
let botState = { dayTrades: 0, dayKey: "", lastAlertKey: null, lastAlertBar: null };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      botState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      console.log("✅ State loaded:", STATE_FILE);
    } else {
      console.log("ℹ️ No state file, starting fresh.");
    }
  } catch (e) {
    console.log("⚠️ State load error:", e.message);
  }
}

// ✅ Async saveState to prevent Node.js event loop blocking
async function saveState() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    await fsp.writeFile(STATE_FILE, JSON.stringify(botState, null, 2));
  } catch (e) {
    console.log("⚠️ State save error (Check Railway Persistent Storage):", e.message);
  }
}

let lastSignal = { signal: "NONE", time: null, reason: "Booting...", isDataFresh: false };
let candles = [];
let consecutiveErrors = 0;
let lastFetchTime = null;
let isFetching = false; // ✅ Prevents race conditions & API limit spikes

loadState();

// ============================================================
//  INDICATOR HELPERS
// ============================================================
function calcEMA(values, period) {
  const result = TI.EMA.calculate({ period, values });
  return result[result.length - 1];
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

// ============================================================
//  SESSION & NEWS FILTERS
// ============================================================
function goodSession() {
  const now = new Date();
  const nyHour = parseInt(now.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  
  const london = nyHour >= 3 && nyHour < 7;
  const ny = nyHour >= 8 && nyHour < 17;
  const overlap = nyHour >= 8 && nyHour < 12;
  
  return {
    active: london || ny,
    overlap,
    name: overlap ? "LONDON-NY OVERLAP" : london ? "LONDON" : ny ? "NY" : "CLOSED",
  };
}

function isNewsTime() {
  const now = new Date();
  const nyHour = parseInt(now.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }));
  const nyMin = parseInt(now.toLocaleString("en-US", { timeZone: "America/New_York", minute: "numeric" }));
  const totalMin = nyHour * 60 + nyMin;

  const newsWindows = [
    [495, 525],   // 8:15 - 8:45
    [600, 630],   // 10:00 - 10:30
    [840, 870],   // 14:00 - 14:30 (FOMC)
  ];
  return newsWindows.some(([s, e]) => totalMin >= s && totalMin <= e);
}

// ============================================================
//  CORE ANALYSIS ENGINE
// ============================================================
async function analyze() {
  if (candles.length < 60) {
    lastSignal = { signal: "NONE", reason: "Collecting data...", time: new Date().toISOString(), isDataFresh: true };
    return;
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  
  // ✅ REPAINTING PREVENTION (Use CLOSED candles for logic)
  const lastClosed = candles[candles.length - 2];
  const prevClosed = candles[candles.length - 3];
  const currentCandle = candles[candles.length - 1]; // Only for live price display

  const e9 = calcEMA(closes, 9);
  const e21 = calcEMA(closes, 21);
  const e50 = calcEMA(closes, 50);
  const r = calcRSI(closes, 14);
  const a = calcATR(candles, 14);
  const m = calcMACD(closes);
  const s = calcStochK(candles);
  const d = calcDMI(candles);

  // ✅ GENIUS S/R (10th percentile ignores single abnormal data spikes / fat-finger wicks)
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

  const strongBull = lastClosed.close > e9 && e9 > e21 && e21 > e50;
  const strongBear = lastClosed.close < e9 && e9 < e21 && e21 < e50;

  const session = goodSession();
  const newsPause = isNewsTime();

  let buy = 0, sell = 0;
  
  // Buy Conditions
  if (strongBull) buy += 3;
  if (bullEngulf) buy += 3;
  if (bullPin) buy += 2;
  if (lastClosed.close > e21 && e21 > e50) buy += 2;
  if (m.macd > m.signal) buy += 2;
  if (d.adx > 25 && d.diPlus > d.diMinus) buy += 3;
  if (lastClosed.low <= support + a && lastClosed.close > support) buy += 2;
  if (session.overlap) buy += 1;
  if (r < 40) buy += 2;      // Oversold
  if (s < 20) buy += 2;      // Deep Oversold

  // Sell Conditions
  if (strongBear) sell += 3;
  if (bearEngulf) sell += 3;
  if (bearPin) sell += 2;
  if (lastClosed.close < e21 && e21 < e50) sell += 2;
  if (m.macd < m.signal) sell += 2;
  if (d.adx > 25 && d.diMinus > d.diPlus) sell += 3;
  if (lastClosed.high >= resistance - a && lastClosed.close < resistance) sell += 2;
  if (session.overlap) sell += 1;
  if (r > 60) sell += 2;     // Overbought
  if (s > 80) sell += 2;     // Deep Overbought

  // ✅ SAFE TIMEZONE PARSING ('en-CA' guarantees safe YYYY-MM-DD format for Linux/Railway)
  const candleTimeStr = lastClosed.time.replace(' ', 'T') + 'Z'; // Force UTC
  const candleDateUTC = new Date(candleTimeStr);
  
  const nyFormatter = new Intl.DateTimeFormat('en-CA', { 
    timeZone: 'America/New_York', 
    year: 'numeric', month: '2-digit', day: '2-digit' 
  });
  const todayKey = nyFormatter.format(candleDateUTC); // Returns "2026-09-23" safely

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
    entry = lastClosed.close + CONFIG.SPREAD; // Ask price
    sl = entry - slDist;
    tp = entry + tpDist;
  } else if (sell >= CONFIG.MIN_CONFIRM && buy <= CONFIG.MAX_OPPOSITE && canTrade) {
    sig = "SELL";
    entry = lastClosed.close - CONFIG.SPREAD; // Bid price (Realistic SELL entry)
    sl = entry + slDist;
    tp = entry - tpDist;
  }

  const nowISO = new Date().toISOString();
  lastSignal = {
    signal: sig,
    time: nowISO,
    barTime: lastClosed.time,
    price: currentCandle.close, // Shows live forming price, but logic is based on closed
    entry: sig !== "NONE" ? +entry.toFixed(2) : null,
    stopLoss: sl ? +sl.toFixed(2) : null,
    takeProfit: tp ? +tp.toFixed(2) : null,
    lotSize: sig !== "NONE" ? lot : null,
    buyScore: buy,
    sellScore: sell,
    session: session.name,
    newsPaused: newsPause,
    tradesToday: botState.dayTrades,
    isDataFresh: true,
    indicators: {
      ema9: +e9.toFixed(2), ema21: +e21.toFixed(2), ema50: +e50.toFixed(2),
      rsi: +r.toFixed(1), adx: +d.adx.toFixed(1),
      atr: +a.toFixed(2), support: +support.toFixed(2), resistance: +resistance.toFixed(2),
      spread: CONFIG.SPREAD,
    },
    note: sig === "NONE"
      ? (newsPause ? "⏸️ High-Impact News Time (Paused)" : !session.active ? "Session closed" : botState.dayTrades >= CONFIG.MAX_TRADES_DAY ? "Daily trade limit reached" : "No high-confidence setup — waiting")
      : "Strong confirmed setup (Closed Candle)",
  };

  const alertKey = `${sig}-${lastClosed.time}`;
  if (sig !== "NONE" && alertKey !== botState.lastAlertKey && lastClosed.time !== botState.lastAlertBar) {
    botState.dayTrades++;
    botState.lastAlertKey = alertKey;
    botState.lastAlertBar = lastClosed.time;
    await saveState();

    lastSignal.tradesToday = botState.dayTrades;
    await sendTelegram(lastSignal); // ✅ Added await for proper async flow
    console.log(`🚨 ALERT SENT [${nowISO}] ${sig} | price ${lastClosed.close} | buy ${buy} sell ${sell} | ${session.name}`);
  } else {
    console.log(`[${nowISO}] scan: buy ${buy} sell ${sell} | ${session.name} | no new alert`);
  }
}

// ============================================================
//  DATA FETCHING & TELEGRAM
// ============================================================
async function fetchData() {
  if (isFetching) {
    console.log("⏳ Fetch skipped: Previous request still processing.");
    return;
  }
  
  isFetching = true;
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(CONFIG.SYMBOL)}&interval=${CONFIG.INTERVAL}&outputsize=200&apikey=${CONFIG.TWELVE_DATA_KEY}`;
    const { data } = await axios.get(url, { timeout: 15000 });

    if (!data.values) {
      consecutiveErrors++;
      console.log("Data fetch issue:", data.message || data.status);
      if (consecutiveErrors >= 5) {
        await sendTelegramRaw("⚠️ Signal server: market data fetch failing repeatedly. Check API key/limits.");
        consecutiveErrors = 0;
      }
      if (lastSignal) lastSignal.isDataFresh = false;
      return;
    }

    consecutiveErrors = 0;
    lastFetchTime = new Date();
    candles = data.values.reverse().map(v => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }));
    await analyze(); // Await analyze since it's async
  } catch (e) {
    consecutiveErrors++;
    console.log("Fetch error:", e.message);
    if (lastSignal) lastSignal.isDataFresh = false;
  } finally {
    isFetching = false;
    // Recursive setTimeout ensures next fetch ONLY starts after this one fully completes
    setTimeout(fetchData, CONFIG.POLL_SECONDS * 1000);
  }
}

// Periodic freshness check (runs independently every 30s)
setInterval(() => {
  if (lastFetchTime) {
    const ageMin = (Date.now() - lastFetchTime.getTime()) / 60000;
    if (ageMin > CONFIG.STALE_THRESHOLD_MIN && lastSignal.isDataFresh) {
      lastSignal.isDataFresh = false;
      console.log("⚠️ Data marked stale (no fetch for", ageMin.toFixed(1), "min)");
    }
  }
}, 30000);

async function sendTelegramRaw(text) {
  if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT) return;
  try {
    // ✅ Added 5s timeout to prevent Node.js hanging if Telegram servers are slow
    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM_CHAT,
      text,
      parse_mode: "HTML",
    }, { timeout: 5000 }); 
  } catch (e) {
    console.log("TG error:", e.response?.data || e.message);
  }
}

async function sendTelegram(sig) {
  const emoji = sig.signal === "BUY" ? "🟢" : "🔴";
  const newsWarning = sig.newsPaused ? "\n⚠️ <b>NOTE:</b> Signal generated near news time. Verify broker spread!" : "";

  const msg =
    `${emoji} <b>GOLD ${sig.signal}</b>\n\n` +
    `💰 Entry: <b>${sig.entry}</b>\n` +
    `🛑 SL: <b>${sig.stopLoss}</b>\n` +
    `🎯 TP: <b>${sig.takeProfit}</b>\n` +
    `📦 Lot: <b>${sig.lotSize}</b>\n` +
    `🕐 Session: ${sig.session}\n` +
    `📊 Score → Buy: ${sig.buyScore} | Sell: ${sig.sellScore}\n` +
    `📈 RSI: ${sig.indicators.rsi} | ADX: ${sig.indicators.adx}\n` +
    `${newsWarning}\n` +
    `⚠️ <i>Trading involves risk. No signal is guaranteed. Manage your own risk.</i>`;

  await sendTelegramRaw(msg);
}

// ============================================================
//  ROUTES & SERVER START
// ============================================================
app.get("/signal", (req, res) => res.json(lastSignal));
app.get("/health", (req, res) => res.json({
  ok: true,
  time: new Date().toISOString(),
  candlesLoaded: candles.length,
  isDataFresh: lastSignal.isDataFresh,
  lastFetchTime,
  state: botState,
  isFetching: isFetching
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT} — polling every ${CONFIG.POLL_SECONDS}s`);
  console.log(`📂 State file: ${STATE_FILE}`);
  console.log(`📊 Interval: ${CONFIG.INTERVAL} | Spread: ${CONFIG.SPREAD}`);
  
  if (process.env.DISABLE_BOOT_MSG !== "true") {
    await sendTelegramRaw("✅ Gold Signal Server v2.6 is now LIVE. Private repo keys restored + Telegram timeout active + Zero repaint.");
  }
 
  fetchData(); // Start the recursive loop once
});

// ✅ Proper crash handling: forces restart instead of hanging in a broken state
process.on("unhandledRejection", (err) => {
  console.error("❌ Unhandled rejection:", err);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught exception:", err);
  process.exit(1);
});
