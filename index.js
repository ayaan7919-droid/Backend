// ============================================================
//  GOLD (XAUUSD) REALTIME SIGNAL SERVER — v3.4 (Keep-Alive)
// ============================================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const TI = require("technicalindicators");

const app = express();
app.use(cors());

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
  ENABLE_MTF: true,
  MTF_TIMEFRAMES: ['15min', '1h'], 
  TWELVE_DATA_KEY: process.env.TD_KEY,
  TELEGRAM_TOKEN: process.env.TG_TOKEN,
  TELEGRAM_CHAT: process.env.TG_CHAT,
};

// STATE
let botState = { dayTrades: 0, dayKey: "" };
let lastSignal = { signal: "NONE", time: null };
let candles = [];
let isFetching = false;

// SIMPLE HEALTH CHECK - Railway ko satisfy karne ke liye
app.get("/", (req, res) => {
  res.send("✅ Gold Bot is running");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", time: Date.now() });
});

app.get("/signal", (req, res) => res.json(lastSignal));

// SERVER START
const PORT = parseInt(process.env.PORT) || 3000;

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📊 Interval: ${CONFIG.INTERVAL} | MTF: ON`);
  
  // Boot message
  if (process.env.DISABLE_BOOT_MSG !== "true" && process.env.TG_TOKEN) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`,
        {
          chat_id: process.env.TG_CHAT,
          text: "✅ <b>Gold Signal Server v3.4 (Keep-Alive)</b> is LIVE!",
          parse_mode: "HTML"
        }
      ).catch(() => {});
    } catch (e) {}
  }
  
  fetchData();
});

// 🛡️ KEEP-ALIVE: Har 30 seconds mein self-ping
setInterval(() => {
  axios.get(`http://localhost:${PORT}/health`).catch(() => {});
}, 30000);

// MAIN DATA FETCH & ANALYZE
async function fetchData() {
  if (isFetching) return;
  isFetching = true;
  
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(CONFIG.SYMBOL)}&interval=${CONFIG.INTERVAL}&outputsize=200&apikey=${CONFIG.TWELVE_DATA_KEY}`;
    const { data } = await axios.get(url, { timeout: 15000 });

    if (!data.values) {
      isFetching = false;
      setTimeout(fetchData, CONFIG.POLL_SECONDS * 1000);
      return;
    }

    candles = data.values.reverse().map(v => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }));

    analyze();
  } catch (e) {
    console.error("Fetch Error:", e.message);
  } finally {
    isFetching = false;
    setTimeout(fetchData, CONFIG.POLL_SECONDS * 1000);
  }
}

// SIMPLE ANALYSIS
function analyze() {
  if (candles.length < 60) return;

  const closes = candles.map(c => c.close);
  const lastClosed = candles[candles.length - 2];
  
  const e9 = calcEMA(closes, 9);
  const e21 = calcEMA(closes, 21);
  const r = calcRSI(closes, 14);
  const a = calcATR(candles, 14);

  let buy = 0, sell = 0;
  
  if (lastClosed.close > e9 && e9 > e21) buy += 5;
  if (r < 40) buy += 3;
  if (lastClosed.close < e9 && e9 < e21) sell += 5;
  if (r > 60) sell += 3;

  const slDist = a * CONFIG.ATR_SL;
  const tpDist = a * CONFIG.ATR_TP;
  const riskMoney = CONFIG.ACCOUNT_BALANCE * (CONFIG.RISK_PERCENT / 100);
  let lot = slDist > 0 ? riskMoney / (slDist * CONFIG.CONTRACT_SIZE) : 0.01;
  lot = Math.max(0.01, Math.min(5.0, Math.round(lot * 100) / 100));

  const confidence = Math.min(100, Math.round((Math.max(buy, sell) / 10) * 100));

  const nowISO = new Date().toISOString();
  let sig = "NONE";
  let entry = null, sl = null, tp = null;

  if (buy >= 6 && sell <= 3) {
    sig = "BUY";
    entry = lastClosed.close + CONFIG.SPREAD;
    sl = entry - slDist;
    tp = entry + tpDist;
  } else if (sell >= 6 && buy <= 3) {
    sig = "SELL";
    entry = lastClosed.close - CONFIG.SPREAD;
    sl = entry + slDist;
    tp = entry - tpDist;
  }

  lastSignal = {
    signal: sig,
    time: nowISO,
    price: lastClosed.close,
    entry: entry ? +entry.toFixed(2) : null,
    stopLoss: sl ? +sl.toFixed(2) : null,
    takeProfit: tp ? +tp.toFixed(2) : null,
    lotSize: lot,
    confidence: confidence,
    buyScore: buy,
    sellScore: sell,
  };

  console.log(`[${nowISO}] scan: buy ${buy} sell ${sell} | confidence ${confidence}% | no new alert`);
}

// INDICATORS
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

// Error handling
process.on("unhandledRejection", () => process.exit(1));
process.on("uncaughtException", () => process.exit(1));
