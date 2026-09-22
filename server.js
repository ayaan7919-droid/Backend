// ============================================================
//  GOLD (XAUUSD) REALTIME SIGNAL SERVER — v2.0 (Production Ready)
//  Deploy on: Railway (with Volume at /app)
// ============================================================

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.static("public"));

// ============================================================
//  CONFIG (API Keys Unchanged as Requested)
// ============================================================
const CONFIG = {
  SYMBOL: "XAU/USD",
  INTERVAL: "1min",
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
  POLL_SECONDS: 60,

  TWELVE_DATA_KEY: process.env.TD_KEY || "5ba753f104e94af7b7345228d078c43e",
  TELEGRAM_TOKEN: process.env.TG_TOKEN || "8867660132:AAErPb1wWfg-sici_vUzp8KJsAJNRB33wPA",
  TELEGRAM_CHAT: process.env.TG_CHAT || "8719496087",
};

// ============================================================
//  STATE MANAGEMENT (Persistent via JSON File - Railway Volume)
// ============================================================
const STATE_FILE = "/app/bot_state.json";
let botState = { dayTrades: 0, dayKey: "", lastAlertKey: null, lastAlertBar: null };

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      botState = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      console.log("✅ State loaded from volume:", botState);
    } else {
      console.log("ℹ️ No existing state file, starting fresh.");
    }
  } catch (e) {
    console.log("⚠️ State load error, using defaults:", e.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(botState, null, 2));
  } catch (e) {
    console.log("⚠️ State save error:", e.message);
  }
}

let lastSignal = { signal: "NONE", time: null, reason: "Booting..." };
let candles = [];
let consecutiveErrors = 0;

loadState();

// ============================================================
//  INDICATOR HELPERS (TradingView Accurate - Wilder's Smoothing)
// ============================================================
function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

function calculateRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[closes.length - period - 1 + i] - closes[closes.length - period - 1 + i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = closes.length - period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let atr = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    atr += tr;
  }
  atr /= period;
  for (let i = candles.length - period + 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    atr = (atr * (period - 1) + tr) / period;
  }
  return atr;
}

function macd(closes) {
  const e12 = emaSeries(closes, 12);
  const e26 = emaSeries(closes, 26);
  const macdLine = e12.map((v, i) => v - e26[i]);
  const signalLine = emaSeries(macdLine, 9);
  const last = macdLine.length - 1;
  return { macd: macdLine[last], signal: signalLine[last] };
}

function stochK(c, period = 14) {
  const slice = c.slice(-period);
  const hh = Math.max(...slice.map(x => x.high));
  const ll = Math.min(...slice.map(x => x.low));
  const close = c[c.length - 1].close;
  return hh === ll ? 50 : ((close - ll) / (hh - ll)) * 100;
}

function dmi(c, period = 14) {
  let plusDM = 0, minusDM = 0, trSum = 0;
  const start = Math.max(1, c.length - period);
  for (let i = start; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high;
    const down = c[i - 1].low - c[i].low;
    plusDM += up > down && up > 0 ? up : 0;
    minusDM += down > up && down > 0 ? down : 0;
    trSum += Math.max(
      c[i].high - c[i].low,
      Math.abs(c[i].high - c[i - 1].close),
      Math.abs(c[i].low - c[i - 1].close)
    );
  }
  const diPlus = trSum === 0 ? 0 : (plusDM / trSum) * 100;
  const diMinus = trSum === 0 ? 0 : (minusDM / trSum) * 100;
  const dx = diPlus + diMinus === 0 ? 0 : (Math.abs(diPlus - diMinus) / (diPlus + diMinus)) * 100;
  return { diPlus, diMinus, adx: dx };
}

// ============================================================
//  SESSION & NEWS FILTERS
// ============================================================
function getNYDayKey() {
  const nyDate = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return nyDate.toISOString().slice(0, 10);
}

function goodSession() {
  const h = new Date().getUTCHours();
  const london = h >= 8 && h < 12;
  const ny = h >= 13 && h < 17;
  const overlap = h >= 13 && h < 16;
  return {
    active: london || ny,
    overlap,
    name: overlap ? "LONDON-NY OVERLAP" : london ? "LONDON" : ny ? "NY" : "CLOSED",
  };
}

function isNewsTime() {
  const now = new Date();
  const currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const isMorningNews = currentMinutes >= 780 && currentMinutes <= 840;
  const isAfternoonNews = currentMinutes >= 1050 && currentMinutes <= 1110;
  return isMorningNews || isAfternoonNews;
}

// ============================================================
//  CORE ANALYSIS ENGINE
// ============================================================
function analyze() {
  if (candles.length < 60) {
    lastSignal = { signal: "NONE", reason: "Collecting data...", time: new Date().toISOString() };
    return;
  }

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const e9 = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  const r = calculateRSI(closes, 14);
  const a = calculateATR(candles, 14);
  const m = macd(closes);
  const s = stochK(candles);
  const d = dmi(candles);

  const support = Math.min(...lows.slice(-50));
  const resistance = Math.max(...highs.slice(-50));

  const body = Math.abs(last.close - last.open);
  const prevBody = Math.abs(prev.close - prev.open);
  const bullEngulf = last.close > last.open && prev.close < prev.open && last.open <= prev.close && last.close >= prev.open && body > prevBody;
  const bearEngulf = last.close < last.open && prev.close > prev.open && last.open >= prev.close && last.close <= prev.open && body > prevBody;

  const wickLow = last.close > last.open ? last.open - last.low : last.close - last.low;
  const wickHigh = last.close > last.open ? last.high - last.close : last.high - last.open;
  const bullPin = wickLow > body * 2 && wickHigh < body * 0.5;
  const bearPin = wickHigh > body * 2 && wickLow < body * 0.5;

  const strongBull = last.close > e9 && e9 > e21 && e21 > e50;
  const strongBear = last.close < e9 && e9 < e21 && e21 < e50;

  const session = goodSession();
  const newsPause = isNewsTime();

  let buy = 0, sell = 0;
  if (strongBull) buy += 3;
  if (bullEngulf) buy += 3;
  if (bullPin) buy += 2;
  if (last.close > e21 && e21 > e50) buy += 2;
  if (r > 45 && r < 65) buy += 1;
  if (m.macd > m.signal) buy += 2;
  if (d.adx > 25 && d.diPlus > d.diMinus) buy += 3;
  if (s < 80) buy += 1;
  if (last.low <= support + a && last.close > support) buy += 2;
  if (session.overlap) buy += 1;

  if (strongBear) sell += 3;
  if (bearEngulf) sell += 3;
  if (bearPin) sell += 2;
  if (last.close < e21 && e21 < e50) sell += 2;
  if (r < 55 && r > 35) sell += 1;
  if (m.macd < m.signal) sell += 2;
  if (d.adx > 25 && d.diMinus > d.diPlus) sell += 3;
  if (s > 20) sell += 1;
  if (last.high >= resistance - a && last.close < resistance) sell += 2;
  if (session.overlap) sell += 1;

  const todayKey = getNYDayKey();
  if (todayKey !== botState.dayKey) {
    botState.dayKey = todayKey;
    botState.dayTrades = 0;
    saveState();
  }

  const canTrade = session.active && !newsPause && botState.dayTrades < CONFIG.MAX_TRADES_DAY;

  const slDist = a * CONFIG.ATR_SL;
  const tpDist = Math.max(a * CONFIG.ATR_TP, slDist * CONFIG.MIN_RR);
  const riskMoney = CONFIG.ACCOUNT_BALANCE * (CONFIG.RISK_PERCENT / 100);

  let lot = riskMoney / (slDist * CONFIG.CONTRACT_SIZE);
  lot = Math.max(0.01, Math.min(5.0, Math.round(lot * 100) / 100));

  let sig = "NONE", entry = last.close, sl = null, tp = null;

  if (buy >= CONFIG.MIN_CONFIRM && sell <= CONFIG.MAX_OPPOSITE && canTrade) {
    sig = "BUY";
    entry = last.close + CONFIG.SPREAD;
    sl = entry - slDist;
    tp = entry + tpDist;
  } else if (sell >= CONFIG.MIN_CONFIRM && buy <= CONFIG.MAX_OPPOSITE && canTrade) {
    sig = "SELL";
    entry = last.close;
    sl = entry + slDist;
    tp = entry - tpDist;
  }

  lastSignal = {
    signal: sig,
    time: new Date().toISOString(),
    barTime: last.time,
    price: last.close,
    entry: sig !== "NONE" ? +entry.toFixed(2) : null,
    stopLoss: sl ? +sl.toFixed(2) : null,
    takeProfit: tp ? +tp.toFixed(2) : null,
    lotSize: sig !== "NONE" ? lot : null,
    buyScore: buy,
    sellScore: sell,
    session: session.name,
    newsPaused: newsPause,
    tradesToday: botState.dayTrades,
    indicators: {
      ema9: +e9.toFixed(2), ema21: +e21.toFixed(2), ema50: +e50.toFixed(2),
      rsi: +r.toFixed(1), adx: +d.adx.toFixed(1),
      atr: +a.toFixed(2), support: +support.toFixed(2), resistance: +resistance.toFixed(2),
      spread: CONFIG.SPREAD,
    },
    note: sig === "NONE"
      ? (newsPause ? "⏸️ High-Impact News Time (Paused)" : !session.active ? "Session closed" : botState.dayTrades >= CONFIG.MAX_TRADES_DAY ? "Daily trade limit reached" : "No high-confidence setup — waiting")
      : "Strong confirmed setup",
  };

  const alertKey = `${sig}-${last.time}`;
  if (sig !== "NONE" && alertKey !== botState.lastAlertKey && last.time !== botState.lastAlertBar) {
    botState.dayTrades++;
    botState.lastAlertKey = alertKey;
    botState.lastAlertBar = last.time;
    saveState();

    lastSignal.tradesToday = botState.dayTrades;
    sendTelegram(lastSignal);
    console.log(`🚨 ALERT SENT [${lastSignal.time}] ${sig} | price ${last.close} | buy ${buy} sell ${sell} | ${session.name}`);
  } else {
    console.log(`[${lastSignal.time}] scan: buy ${buy} sell ${sell} | ${session.name} | no new alert`);
  }
}

// ============================================================
//  DATA FETCHING & TELEGRAM
// ============================================================
async function fetchData() {
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
      return;
    }

    consecutiveErrors = 0;
    candles = data.values.reverse().map(v => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }));
    analyze();
  } catch (e) {
    consecutiveErrors++;
    console.log("Fetch error:", e.message);
  }
}

async function sendTelegramRaw(text) {
  if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT) return;
  try {
    await axios.post(`https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: CONFIG.TELEGRAM_CHAT,
      text,
      parse_mode: "HTML",
    });
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
    `${newsWarning}` +
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
  state: botState
}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Server running on port ${PORT} — polling every ${CONFIG.POLL_SECONDS}s`);
  console.log(`📂 State file: ${STATE_FILE}`);
  await sendTelegramRaw("✅ Gold Signal Server v2.0 is now LIVE. State persistence & News filters active.");
  fetchData();
  setInterval(fetchData, CONFIG.POLL_SECONDS * 1000);
});

process.on("unhandledRejection", (err) => console.log("Unhandled rejection:", err));
process.on("uncaughtException", (err) => console.log("Uncaught exception:", err));
