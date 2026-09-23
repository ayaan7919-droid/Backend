// ============================================================
//  GOLD (XAUUSD) REALTIME SIGNAL SERVER — v4.11
//  Changes vs v4.10:
//   - STATE_PATH directory auto-create: agar STATE_PATH ek aisi directory
//     point kare jo exist nahi karti, pehle fs.writeFileSync silently fail
//     ho jata tha (sirf console.error, state kabhi save nahi hota tha).
//     Ab startup par `fs.mkdirSync(path.dirname(STATE_FILE), { recursive:
//     true })` chal jata hai taake volume-mounted path (e.g.
//     STATE_PATH=/data/bot_state.json) pehli baar bhi kaam kare.
//   - CONSTANT-TIME API KEY COMPARE: `key !== CONFIG.API_KEY` plain string
//     comparison timing-attack-safe nahi thi. Ab `crypto.timingSafeEqual`
//     use hota hai (length-safe wrapper ke saath, kyunke timingSafeEqual
//     mismatched-length buffers par khud throw karta hai).
//  Changes vs v4.9:
//   - MT5 BRIDGE FIELD ALIASES: bridge `direction`/`lot`/`sl`/`tp` keys expect
//     karta hai, jabke canonical fields `signal`/`lotSize`/`stopLoss`/`takeProfit`
//     hain. /signal JSON ab dono deta hai (aliases), taake bridge bina mapping
//     layer ke seedha parse kar sake. Canonical fields unchanged rahenge.
//   - BRIDGE SAFETY: `direction` ab signal == "NONE" hone par `null` deta hai,
//     string "NONE" nahi — warna truthy-check karne wala bridge code galti se
//     "NONE" ko bhi valid signal samajh sakta tha.
//   - STATE_PATH env: state file ka path configurable (e.g. Railway volume par
//     STATE_PATH=/data/bot_state.json), taake redeploy par activeTrades tracking
//     wipe na ho. Default pehle jaisa hai (bot_state.json, same folder).
//  Changes vs v4.7:
//   - MT5 BRIDGE COMPAT: bridge "XAUUSD" format (bina slash) expect karta hai,
//     jabke Twelve Data API ko "XAU/USD" chahiye. Is liye CONFIG.SYMBOL_MT5
//     add kiya ("XAU/USD" -> "XAUUSD"). Bridge-facing outputs — /signal JSON
//     ka `symbol` field, tracked trades, aur Telegram messages — ab XAUUSD
//     format use karte hain. Twelve Data API calls ab bhi CONFIG.SYMBOL
//     ("XAU/USD") use karte hain, koi data change nahi.
//  Changes vs v4.6:
//   - SECURITY FIX: /health ab activeTrades (entry/SL/TP/lot) aur dayTrades
//     jaisi sensitive details sirf tab deta hai jab valid x-api-key header
//     bheja jaye (agar API_KEY set hai). Bina key ke sirf basic public
//     status (status/time/marketOpen/dryRun) milega — isse UptimeRobot jaisi
//     external monitoring services bina auth ke bhi ping kar sakti hain,
//     lekin open positions publicly leak nahi hote.
//   - MAX_TRADES_DAY ab env se configurable hai (MAX_TRADES_DAY), pehle
//     hardcoded tha jabke baaki config env-driven thi.
//  Changes vs v4.5:
//   - MULTI-TRADE TRACKING: ab sirf ek nahi, JITNE bhi signals Telegram par
//     jayein SAB track hote hain (activeTrades array). Har trade ka TP hit ->
//     "✅ PASS", SL hit -> "❌ FAIL" message. Purana v4.5 ka single activeTrade
//     state load par automatically array me migrate ho jata hai.
//  Changes vs v4.4:
//   - TRADE OUTCOME TRACKING: jab Telegram par signal jaye, bot us trade ka
//     TP/SL track karta hai. TP hit -> "✅ PASS" message, SL hit -> "❌ FAIL"
//     message Telegram par. Trade bot_state.json me persist hota hai (restart
//     par bhi track rehta hai). DRY_RUN me koi outcome message nahi jata.
//  Changes vs v4.3 (backtest-optimized 2026-09-23, 15,000 real 5m candles):
//   - MIN_CONFIRM default 6 -> 5, ATR_TP 5.0 -> 6.0 (R:R 2.5 -> 3.0).
//     Train (70%): PF 1.57, 31.3% WR, +$2.81/trade | Test (30%): PF 1.45,
//     33.3% WR, +$2.34/trade — vs v4.3 defaults train PF 1.18 / test PF 1.20.
//     Selection caveat: test set was used to pick among shortlisted configs,
//     so treat test metrics as optimistic. Win rates are ~30-35% by design
//     at 3:1 R:R (breakeven 25%) — never expect anywhere near 90%.
//   - BUGFIX: lastSignal.dayTrades is now refreshed AFTER botState.dayTrades++
//     (previously /signal reported the stale pre-increment count).
//  Changes vs v4.2:
//   1. GRANULAR CONFIDENCE: 10-point scoring (trend 4 + RSI 3 + candle conviction 3).
//      Confidence ab 60-100% vary karega — v4.2 me hamesha 100% hota tha (design flaw).
//   2. STALE-DATA GUARD: last candle age > STALE_MINUTES ya market closed (NY) -> scan skip.
//      (Weekend par Friday ke stale candles par signal nahi niklega.)
//   3. SMARTER POLLING: base poll 180s, MTF sirf har 4th poll par.
//      ~480 base + ~240 MTF = ~720 credits/day (Twelve Data free 800 limit ke andar).
//   4. MTF FAIL-CLOSED: higher-TF data unavailable ho to signal REJECT (v4.2 me pass ho jata tha).
//   5. DRY_RUN mode: Telegram bheje baghair live logic test kar sakte ho.
//   6. API_KEY missing par loud startup warning (pehle /signal silent public tha).
//  Kept from v4.2: NY-timezone day reset, state persistence, anti-repaint (-2 index),
//  Telegram NY timestamp + spread note, NaN safety, safe /signal default.
//
//  NOTE: bot_state.json is written to local disk (override via STATE_PATH env).
//  On an ephemeral filesystem (Render/Railway default), a redeploy or restart
//  can wipe activeTrades tracking — set STATE_PATH to a persistent volume mount
//  (e.g. STATE_PATH=/data/bot_state.json on Railway) to survive restarts.
//  For multi-instance setups, use an external store (Redis, a tiny Postgres
//  table, etc.) instead of the local file.
// ============================================================

require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const TI = require("technicalindicators");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors());

// ---------------------------------------------------------------
// SECURITY / ENV CHECK
// ---------------------------------------------------------------
if (!process.env.TD_KEY || !process.env.TG_TOKEN || !process.env.TG_CHAT) {
  console.error("FATAL: Missing required environment variables (TD_KEY, TG_TOKEN, TG_CHAT).");
  process.exit(1);
}

// ---------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------
const CONFIG = {
  SYMBOL: "XAU/USD",
  INTERVAL: process.env.INTERVAL || "5min",
  SPREAD: 0.30,
  CONTRACT_SIZE: 100,
  ACCOUNT_BALANCE: parseFloat(process.env.ACCOUNT_BALANCE) || 1000,
  RISK_PERCENT: parseFloat(process.env.RISK_PERCENT) || 1.0,
  ATR_SL: 2.0,
  ATR_TP: 6.0, // v4.4: backtest-optimized (was 5.0) -> R:R 3.0
  MIN_RR: 2.5,
  MIN_CONFIRM: parseInt(process.env.MIN_CONFIRM) || 5, // of 10 (v4.4: backtest-optimized)
  MAX_OPPOSITE: parseInt(process.env.MAX_OPPOSITE) || 3,
  MAX_TRADES_DAY: parseInt(process.env.MAX_TRADES_DAY) || 3, // v4.7: env-configurable
  // 180s base poll = 480 calls/day; MTF every 4th poll = 120 x 2 = 240 calls/day
  // Total ~720/day — safe under Twelve Data free tier (800/day).
  POLL_SECONDS: parseInt(process.env.POLL_SECONDS) || 180,
  MTF_EVERY_N_POLLS: parseInt(process.env.MTF_EVERY_N_POLLS) || 4,
  ENABLE_MTF: process.env.ENABLE_MTF !== "false",
  MTF_TIMEFRAMES: ["15min", "1h"],
  MTF_MIN_AGREE: 1,
  // Stale-data guard: last closed candle is se zyada purana ho to scan skip
  STALE_MINUTES: parseInt(process.env.STALE_MINUTES) || 45,
  CANDLE_TZ: process.env.CANDLE_TZ || "UTC", // Twelve Data intraday forex timestamps
  // IMPORTANT: Twelve Data ke "Exchange" default timezone me XAU/USD ke timestamps
  // ~10h aage aate hain (verified 2026-09-23). Hamesha explicit timezone bhejo.
  TD_TIMEZONE: process.env.TD_TIMEZONE || "UTC",
  DRY_RUN: process.env.DRY_RUN === "true", // true = Telegram log only, send nothing
  TWELVE_DATA_KEY: process.env.TD_KEY,
  TELEGRAM_TOKEN: process.env.TG_TOKEN,
  TELEGRAM_CHAT: process.env.TG_CHAT,
  API_KEY: process.env.API_KEY || null,
};

const MAX_SCORE = 10; // 4 (trend) + 3 (RSI) + 3 (candle conviction)
// v4.9: state file ka path env se configurable — Railway par volume mount karo
// (e.g. STATE_PATH=/data/bot_state.json), warna ephemeral disk par redeploy
// me activeTrades tracking + daily count wipe ho jayegi.
const STATE_FILE = process.env.STATE_PATH || path.join(__dirname, "bot_state.json");

// v4.11: agar STATE_FILE ki directory exist nahi karti (e.g. fresh volume
// mount), pehle writeFileSync silently fail ho jata tha. Startup par hi
// directory ensure kar do taake state save hona guaranteed ho.
try {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
} catch (e) {
  console.error("⚠️ Failed to ensure STATE_FILE directory exists:", e.message);
}

// MT5 bridge compatibility: broker/MT5 symbol me slash nahi hota (XAUUSD),
// jabke Twelve Data API ko "XAU/USD" chahiye. API calls CONFIG.SYMBOL use
// karte hain; bridge-facing outputs (Telegram, /signal JSON, tracked trades)
// CONFIG.SYMBOL_MT5 use karte hain.
CONFIG.SYMBOL_MT5 = CONFIG.SYMBOL.replace("/", "");

// ---------------------------------------------------------------
// STATE MANAGEMENT (PERSISTENT)
// ---------------------------------------------------------------
let botState = { dayTrades: 0, dayKey: todayKey() };
let lastAlertedSignalKey = null;
let candles = [];
let isFetching = false;
let pollCount = 0;
let mtfCache = {};
let lastScanAt = null;
let lastCandleAgeMin = null;

function todayKey() {
  return new Date()
    .toLocaleDateString("en-US", { timeZone: "America/New_York" })
    .replace(/\//g, "-");
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      botState = parsed.botState || botState;
      lastAlertedSignalKey = parsed.lastAlertedSignalKey || null;
      // v4.6 migration: v4.5 ka single activeTrade -> activeTrades array
      if (botState.activeTrade && !Array.isArray(botState.activeTrades)) {
        botState.activeTrades = [botState.activeTrade];
        delete botState.activeTrade;
        console.log("🔄 Migrated single activeTrade -> activeTrades array.");
      }
      if (!Array.isArray(botState.activeTrades)) botState.activeTrades = [];
      if (botState.dayKey !== todayKey()) {
        console.log(`🔄 Day changed from ${botState.dayKey} to ${todayKey()}. Resetting daily trades.`);
        botState.dayKey = todayKey();
        botState.dayTrades = 0;
        saveState();
      }
      console.log("✅ State loaded from file.");
    }
  } catch (e) {
    console.error("⚠️ Failed to load state, using defaults:", e.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ botState, lastAlertedSignalKey }, null, 2), "utf8");
  } catch (e) {
    console.error("⚠️ Failed to save state:", e.message);
  }
}

// ---------------------------------------------------------------
// TIME HELPERS
// ---------------------------------------------------------------
// "YYYY-MM-DD HH:MM:SS" wall-time in `timeZone` -> UTC milliseconds
function zonedTimeToUtc(dateStr, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(dateStr);
  if (!m) return NaN;
  const nums = m.slice(1).map(Number);
  const guess = Date.UTC(nums[0], nums[1] - 1, nums[2], nums[3], nums[4], nums[5]);
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const parts = {};
    for (const p of fmt.formatToParts(new Date(guess))) parts[p.type] = p.value;
    const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day,
      (+parts.hour) % 24, +parts.minute, +parts.second);
    return guess - (asUTC - guess);
  } catch {
    return NaN;
  }
}

// Spot gold weekend hours in New York time: closed all Saturday,
// closed Sunday 00:00–18:00 (reopens ~18:00 ET Sunday)
function marketOpenNY(at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(at).reduce((a, p) => ((a[p.type] = p.value), a), {});
  const day = parts.weekday;
  const hour = parseInt(parts.hour, 10) % 24;
  if (day === "Sat") return false;
  if (day === "Sun" && hour < 18) return false;
  return true;
}

// ---------------------------------------------------------------
// AUTH HELPER (v4.7, constant-time compare since v4.11)
// ---------------------------------------------------------------
// timingSafeEqual throws on mismatched buffer lengths, so pad/compare via
// a fixed-length hash instead of the raw strings — this keeps the function
// safe for any input length without extra length checks leaking info.
function safeEqual(a, b) {
  const bufA = crypto.createHash("sha256").update(String(a)).digest();
  const bufB = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthed(req) {
  if (!CONFIG.API_KEY) return true; // no key configured -> nothing to gate
  const key = req.headers["x-api-key"];
  return !!key && safeEqual(key, CONFIG.API_KEY);
}

// ---------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------
app.get("/", (req, res) => {
  res.send("✅ Gold Bot v4.11 is running");
});

app.get("/health", (req, res) => {
  // v4.7 SECURITY FIX: previously this endpoint always returned activeTrades
  // (with entry/SL/TP/lot) and dayTrades unauthenticated. Now that detail is
  // only included when a valid x-api-key header is sent (or when no API_KEY
  // is configured at all). A minimal public status is always returned so
  // uptime monitors (UptimeRobot etc.) that can't send custom headers still work.
  const publicStatus = {
    status: "ok",
    time: Date.now(),
    marketOpen: marketOpenNY(),
    dryRun: CONFIG.DRY_RUN,
  };

  if (!isAuthed(req)) {
    return res.json(publicStatus);
  }

  res.json({
    ...publicStatus,
    dayTrades: botState.dayTrades,
    dayKey: botState.dayKey,
    activeTrades: botState.activeTrades || [],
    lastScanAt,
    candleAgeMin: lastCandleAgeMin,
    pollCount,
  });
});

app.get("/signal", (req, res) => {
  if (CONFIG.API_KEY && !isAuthed(req)) {
    return res.status(401).json({ error: "unauthorized: valid x-api-key header required" });
  }
  // v4.9: MT5 bridge aliases — bridge `direction`/`lot`/`sl`/`tp` keys expect
  // karta hai. Canonical fields (signal/lotSize/stopLoss/takeProfit) bhi rehte
  // hain taake existing consumers na tooten.
  // v4.10 BRIDGE SAFETY: `direction` ab NONE par `null` hai, string "NONE"
  // nahi — "NONE" truthy hoti (non-empty string), isliye agar bridge sirf
  // `if (direction)` check karta to galti se order place kar sakta tha.
  res.json({
    ...lastSignal,
    direction: lastSignal.signal === "NONE" ? null : lastSignal.signal,
    lot: lastSignal.lotSize,
    sl: lastSignal.stopLoss,
    tp: lastSignal.takeProfit,
  });
});

// ---------------------------------------------------------------
// SERVER START
// ---------------------------------------------------------------
function estCreditsPerDay() {
  const base = Math.ceil(86400 / CONFIG.POLL_SECONDS);
  const mtf = CONFIG.ENABLE_MTF ? Math.ceil(base / CONFIG.MTF_EVERY_N_POLLS) * CONFIG.MTF_TIMEFRAMES.length : 0;
  return base + mtf;
}

function start() {
  if (!CONFIG.API_KEY) {
    console.warn("⚠️ WARNING: API_KEY not set — /signal and full /health details are PUBLIC. Set API_KEY in env to protect them.");
  }
  if (CONFIG.DRY_RUN) {
    console.log("🧪 DRY_RUN enabled — Telegram messages will be logged, not sent.");
  }
  const PORT = parseInt(process.env.PORT) || 3000;

  app.listen(PORT, "0.0.0.0", async () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📊 Interval: ${CONFIG.INTERVAL} | MTF: ${CONFIG.ENABLE_MTF ? `ON (every ${CONFIG.MTF_EVERY_N_POLLS} polls)` : "OFF"} | Poll: ${CONFIG.POLL_SECONDS}s | Est. credits/day: ~${estCreditsPerDay()}`);

    loadState();

    if (!CONFIG.DRY_RUN && process.env.DISABLE_BOOT_MSG !== "true") {
      await sendTelegram(
        `✅ <b>Gold Signal Server v4.11</b> is LIVE!\n🕒 Broker Timezone: America/New_York\n🛡️ Anti-repaint, stale-data guard, fail-closed MTF & authenticated /health enabled.\n📣 Trade outcome tracking ON — har signal track hoga, TP par PASS / SL par FAIL aayega.`
      ).catch((e) => console.error("Boot message failed:", e.message));
    }

    fetchData();
  });

  // Local liveness log (does NOT prevent platform sleep — use UptimeRobot etc.)
  setInterval(() => {
    axios.get(`http://localhost:${PORT}/health`).catch(() => {});
  }, 30000);
}

// ---------------------------------------------------------------
// TELEGRAM
// ---------------------------------------------------------------
async function sendTelegram(text) {
  if (CONFIG.DRY_RUN) {
    console.log("[DRY_RUN] Telegram message suppressed:\n" + text);
    return;
  }
  return axios.post(
    `https://api.telegram.org/bot${CONFIG.TELEGRAM_TOKEN}/sendMessage`,
    { chat_id: CONFIG.TELEGRAM_CHAT, text, parse_mode: "HTML" },
    { timeout: 10000 }
  );
}

// ---------------------------------------------------------------
// DATA FETCH
// ---------------------------------------------------------------
async function fetchSeries(interval, outputsize = 200) {
  // NOTE: timezone explicit bhejna ZAROORI hai — provider default ("Exchange")
  // XAU/USD ke liye ghalat timestamps deta hai (verified: ~10h ahead).
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(
    CONFIG.SYMBOL
  )}&interval=${interval}&outputsize=${outputsize}&timezone=${encodeURIComponent(
    CONFIG.TD_TIMEZONE
  )}&apikey=${CONFIG.TWELVE_DATA_KEY}`;
  const { data } = await axios.get(url, { timeout: 15000 });

  if (!data.values) {
    throw new Error(data.message || `No data returned for interval ${interval}`);
  }

  return data.values.reverse().map((v) => ({
    time: v.datetime,
    open: parseFloat(v.open),
    high: parseFloat(v.high),
    low: parseFloat(v.low),
    close: parseFloat(v.close),
  }));
}

async function fetchData() {
  if (isFetching) return;
  isFetching = true;

  try {
    candles = await fetchSeries(CONFIG.INTERVAL, 200);
    pollCount++;

    // MTF sirf har Nth poll par fetch karo (credit saving), beech me cache use karo
    let mtfCandles = {};
    if (CONFIG.ENABLE_MTF) {
      const doMtf = pollCount % CONFIG.MTF_EVERY_N_POLLS === 1;
      for (const tf of CONFIG.MTF_TIMEFRAMES) {
        if (doMtf) {
          try {
            mtfCandles[tf] = await fetchSeries(tf, 100);
            mtfCache[tf] = mtfCandles[tf];
          } catch (e) {
            console.error(`MTF fetch failed for ${tf}:`, e.message);
            mtfCandles[tf] = null;
          }
        } else {
          mtfCandles[tf] = mtfCache[tf] || null;
        }
      }
    }

    analyze(mtfCandles);
  } catch (e) {
    console.error("❌ Fetch Error:", e.message);
  } finally {
    isFetching = false;
    setTimeout(fetchData, CONFIG.POLL_SECONDS * 1000);
  }
}

// ---------------------------------------------------------------
// INDICATORS (NO REPAINTING — hamesha last CLOSED candle ka index)
// ---------------------------------------------------------------
function emaAt(values, period, idx) {
  const r = TI.EMA.calculate({ period, values });
  const j = idx - period + 1;
  return j >= 0 && j < r.length && isFinite(r[j]) ? r[j] : values[idx];
}

function rsiAt(values, period, idx) {
  const r = TI.RSI.calculate({ period, values });
  const j = idx - period;
  return j >= 0 && j < r.length && isFinite(r[j]) ? r[j] : 50;
}

function atrAt(candleArr, period, idx) {
  const r = TI.ATR.calculate({
    high: candleArr.map((c) => c.high),
    low: candleArr.map((c) => c.low),
    close: candleArr.map((c) => c.close),
    period,
  });
  const j = idx - period;
  return j >= 0 && j < r.length && isFinite(r[j]) ? r[j] : 0;
}

// ---------------------------------------------------------------
// SCORING — 10 points (granular confidence)
//  Trend structure: 4 | RSI zone: 3 | Candle conviction: 3
// ---------------------------------------------------------------
function scoreTimeframe(candleArr) {
  if (!candleArr || candleArr.length < 30) return { buy: 0, sell: 0, valid: false, rsi: null };

  const i = candleArr.length - 2; // last CLOSED candle
  const closes = candleArr.map((c) => c.close);
  const e9 = emaAt(closes, 9, i);
  const e21 = emaAt(closes, 21, i);
  const rsi = rsiAt(closes, 14, i);
  const c = candleArr[i];
  const prev = candleArr[i - 1];
  const range = c.high - c.low;

  let buy = 0, sell = 0;

  // 1) Trend structure (max 4)
  if (e9 > e21) {
    buy += 2;
    if (c.close > e9) buy += 2;
  } else if (e9 < e21) {
    sell += 2;
    if (c.close < e9) sell += 2;
  }

  // 2) RSI zone — trend me pullback (max 3)
  if (rsi < 40) buy += 3;
  else if (rsi < 50) buy += 1;
  if (rsi > 60) sell += 3;
  else if (rsi > 50) sell += 1;

  // 3) Candle conviction (max 3)
  if (c.close > c.open) {
    buy += 1;
    if (range > 0 && (c.close - c.low) / range >= 0.6) buy += 1; // strong close near high
  }
  if (c.close < c.open) {
    sell += 1;
    if (range > 0 && (c.high - c.close) / range >= 0.6) sell += 1; // strong close near low
  }
  if (c.high > prev.high && c.low > prev.low) buy += 1; // HH + HL
  if (c.high < prev.high && c.low < prev.low) sell += 1; // LH + LL

  return { buy, sell, valid: true, rsi: +rsi.toFixed(1) };
}

// ---------------------------------------------------------------
// TRADE OUTCOME TRACKING (v4.5)
// Jab Telegram par signal jaye, us trade ka TP/SL track hota hai.
// TP hit -> "PASS", SL hit -> "FAIL" message Telegram par jata hai.
// ---------------------------------------------------------------

// Pure function — unit testable.
// candles: oldest->newest 5m candles; trade: { dir, entry, sl, tp, signalCandleTime }
// Returns { result: "PASS"|"FAIL", exitPrice, exitTime } ya null (trade abhi open hai).
// Note: ek hi candle me SL aur TP dono touch hon to SL pehle mana jata hai (conservative).
function checkTradeOutcome(candles, trade) {
  if (!candles || !trade || !trade.signalCandleTime) return null;
  for (const c of candles) {
    if (c.time <= trade.signalCandleTime) continue; // signal candle tak ka data ignore
    if (trade.dir === "BUY") {
      if (c.low <= trade.sl) return { result: "FAIL", exitPrice: trade.sl, exitTime: c.time };
      if (c.high >= trade.tp) return { result: "PASS", exitPrice: trade.tp, exitTime: c.time };
    } else if (trade.dir === "SELL") {
      if (c.high >= trade.sl) return { result: "FAIL", exitPrice: trade.sl, exitTime: c.time };
      if (c.low <= trade.tp) return { result: "PASS", exitPrice: trade.tp, exitTime: c.time };
    }
  }
  return null;
}

function formatOutcome(trade, outcome) {
  const won = outcome.result === "PASS";
  const pnlPerOz = trade.dir === "BUY"
    ? outcome.exitPrice - trade.entry
    : trade.entry - outcome.exitPrice;
  const pnl = pnlPerOz * CONFIG.CONTRACT_SIZE * trade.lot;
  const pnlStr = `${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)}`;

  let durStr = "";
  if (trade.openedAt) {
    const mins = Math.max(0, Math.round((Date.now() - Date.parse(trade.openedAt)) / 60000));
    durStr = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
  }

  const head = won ? `✅ <b>PASS — ${trade.dir} ${trade.symbol || CONFIG.SYMBOL_MT5}</b>` : `❌ <b>FAIL — ${trade.dir} ${trade.symbol || CONFIG.SYMBOL_MT5}</b>`;
  const hitLine = won ? `🎯 TP hit: ${outcome.exitPrice}` : `🛑 SL hit: ${outcome.exitPrice}`;
  return (
    `${head}\n` +
    `${hitLine}\n` +
    `📈 Entry: ${trade.entry}\n` +
    `💰 P&L: ${pnlStr} (${trade.lot} lot)\n` +
    (durStr ? `⏱️ Duration: ${durStr}\n` : "") +
    `🕒 Closed: ${outcome.exitTime} (UTC)`
  );
}

// ---------------------------------------------------------------
// MAIN ANALYSIS
// ---------------------------------------------------------------
function baseSignal() {
  return {
    signal: "NONE",
    symbol: CONFIG.SYMBOL_MT5, // MT5 bridge format (XAUUSD) — /signal consumers ke liye
    time: null,
    price: null,
    entry: null,
    stopLoss: null,
    takeProfit: null,
    lotSize: 0.01,
    confidence: 0,
    buyScore: 0,
    sellScore: 0,
    rsi: null,
    dataAsOf: null,
    candleAgeMin: lastCandleAgeMin,
    dayTrades: botState.dayTrades,
    rejectReason: null,
  };
}

let lastSignal = { ...baseSignal(), rejectReason: "Initial startup, analyzing market..." };

function analyze(mtfCandles) {
  if (candles.length < 60) return;

  const key = todayKey();
  if (botState.dayKey !== key) {
    botState.dayKey = key;
    botState.dayTrades = 0;
    saveState();
  }

  const nowISO = new Date().toISOString();
  lastScanAt = nowISO;

  // --- v4.6: SAARE open trades ka outcome check (TP -> PASS, SL -> FAIL) ---
  // Guards se pehle taake outcome report session/stale logic par blocked na ho.
  if (Array.isArray(botState.activeTrades) && botState.activeTrades.length > 0) {
    const stillOpen = [];
    for (const trade of botState.activeTrades) {
      const outcome = checkTradeOutcome(candles, trade);
      if (outcome) {
        console.log(`[${nowISO}] trade outcome: ${trade.dir} ${outcome.result} @ ${outcome.exitPrice}`);
        sendTelegram(formatOutcome(trade, outcome)).catch((e) =>
          console.error("Telegram outcome alert failed:", e.message)
        );
      } else {
        stillOpen.push(trade);
      }
    }
    if (stillOpen.length !== botState.activeTrades.length) {
      botState.activeTrades = stillOpen;
      saveState();
    }
  }

  // --- GUARD 1: market hours (NY) ---
  if (!marketOpenNY()) {
    lastSignal = { ...baseSignal(), time: nowISO, rejectReason: "Market closed (NY weekend hours)" };
    console.log(`[${nowISO}] scan skipped: market closed`);
    return;
  }

  // --- GUARD 2: stale data ---
  const lastClosed = candles[candles.length - 2];
  const ageMin = (Date.now() - zonedTimeToUtc(lastClosed.time, CONFIG.CANDLE_TZ)) / 60000;
  lastCandleAgeMin = isFinite(ageMin) ? +ageMin.toFixed(1) : null;
  if (!isFinite(ageMin) || ageMin < -5 || ageMin > CONFIG.STALE_MINUTES) {
    lastSignal = {
      ...baseSignal(),
      time: nowISO,
      rejectReason: `Stale data — last candle age ${lastCandleAgeMin ?? "unknown"} min (limit ${CONFIG.STALE_MINUTES}, tz ${CONFIG.CANDLE_TZ})`,
    };
    console.log(`[${nowISO}] scan skipped: stale data (age ${lastCandleAgeMin} min)`);
    return;
  }

  const a = atrAt(candles, 14, candles.length - 2);
  const { buy, sell, rsi } = scoreTimeframe(candles);

  const slDist = a * CONFIG.ATR_SL;
  const tpDist = a * CONFIG.ATR_TP;
  const riskMoney = CONFIG.ACCOUNT_BALANCE * (CONFIG.RISK_PERCENT / 100);

  let lot = slDist > 0 ? riskMoney / (slDist * CONFIG.CONTRACT_SIZE) : 0.01;
  lot = Math.max(0.01, Math.min(5.0, Math.round(lot * 1000) / 1000));

  const confidence = Math.min(100, Math.round((Math.max(buy, sell) / MAX_SCORE) * 100));

  let sig = "NONE";
  let entry = null, sl = null, tp = null;
  let rejectReason = null;

  let candidate = null;
  if (buy >= CONFIG.MIN_CONFIRM && sell <= CONFIG.MAX_OPPOSITE) candidate = "BUY";
  else if (sell >= CONFIG.MIN_CONFIRM && buy <= CONFIG.MAX_OPPOSITE) candidate = "SELL";

  // --- MTF confirmation (FAIL-CLOSED: data na ho to signal reject) ---
  if (candidate && CONFIG.ENABLE_MTF) {
    let mtfAgree = 0;
    let mtfValid = 0;
    for (const tf of CONFIG.MTF_TIMEFRAMES) {
      const arr = mtfCandles ? mtfCandles[tf] : null;
      if (!arr) continue;
      const s = scoreTimeframe(arr);
      if (!s.valid) continue;
      mtfValid++;
      if (candidate === "BUY" && s.buy > s.sell) mtfAgree++;
      if (candidate === "SELL" && s.sell > s.buy) mtfAgree++;
    }
    if (mtfValid < CONFIG.MTF_MIN_AGREE) {
      rejectReason = `MTF unavailable (${mtfValid} valid TFs) — fail-closed, no signal`;
      candidate = null;
    } else if (mtfAgree < CONFIG.MTF_MIN_AGREE) {
      rejectReason = `MTF disagreement (${mtfAgree}/${mtfValid} higher TFs agreed)`;
      candidate = null;
    }
  }

  // --- R:R check (NaN-safe) ---
  if (candidate) {
    const rr = slDist > 0 ? tpDist / slDist : 0;
    if (!isFinite(rr) || rr < CONFIG.MIN_RR) {
      rejectReason = `R:R ${isFinite(rr) ? rr.toFixed(2) : "n/a"} below minimum ${CONFIG.MIN_RR}`;
      candidate = null;
    }
  }

  // --- Daily cap ---
  if (candidate && botState.dayTrades >= CONFIG.MAX_TRADES_DAY) {
    rejectReason = `Daily trade cap reached (${botState.dayTrades}/${CONFIG.MAX_TRADES_DAY})`;
    candidate = null;
  }

  if (candidate === "BUY") {
    sig = "BUY";
    entry = lastClosed.close + CONFIG.SPREAD;
    sl = lastClosed.close - slDist;
    tp = lastClosed.close + tpDist;
  } else if (candidate === "SELL") {
    sig = "SELL";
    entry = lastClosed.close - CONFIG.SPREAD;
    sl = lastClosed.close + slDist;
    tp = lastClosed.close - tpDist;
  }

  lastSignal = {
    signal: sig,
    symbol: CONFIG.SYMBOL_MT5, // MT5 bridge format (XAUUSD)
    time: nowISO,
    price: lastClosed.close,
    entry: entry != null ? +entry.toFixed(2) : null,
    stopLoss: sl != null ? +sl.toFixed(2) : null,
    takeProfit: tp != null ? +tp.toFixed(2) : null,
    lotSize: lot,
    confidence,
    buyScore: buy,
    sellScore: sell,
    rsi,
    dataAsOf: lastClosed.time,
    candleAgeMin: lastCandleAgeMin,
    dayTrades: botState.dayTrades,
    rejectReason: sig === "NONE" ? rejectReason : null,
  };

  console.log(
    `[${nowISO}] scan: buy ${buy} sell ${sell} rsi ${rsi} | age ${lastCandleAgeMin}m | confidence ${confidence}% | signal ${sig}` +
      (rejectReason ? ` | rejected: ${rejectReason}` : "")
  );

  if (sig !== "NONE") {
    const alertKey = `${lastClosed.time}-${sig}`;
    if (alertKey !== lastAlertedSignalKey) {
      lastAlertedSignalKey = alertKey;
      botState.dayTrades += 1;
      // v4.6: HAR signal wala trade track karo — TP hit par PASS, SL hit par
      // FAIL message jayega. Ek se zyada trades ek saath open reh sakte hain.
      // DRY_RUN me Telegram jata hi nahi, is liye wahan track bhi nahi karte.
      if (!CONFIG.DRY_RUN) {
        if (!Array.isArray(botState.activeTrades)) botState.activeTrades = [];
        if (botState.activeTrades.length >= 20) {
          console.error("⚠️ activeTrades cap (20) reached — naya trade track nahi hoga");
        } else {
          botState.activeTrades.push({
            dir: sig,
            symbol: CONFIG.SYMBOL_MT5, // MT5 bridge format
            entry: lastSignal.entry,
            sl: lastSignal.stopLoss,
            tp: lastSignal.takeProfit,
            lot: lastSignal.lotSize,
            signalCandleTime: lastClosed.time, // "YYYY-MM-DD HH:MM:SS" (CANDLE_TZ)
            openedAt: nowISO,
          });
        }
      }
      saveState();
      // BUGFIX v4.4: lastSignal was assembled BEFORE the increment, so /signal
      // reported a stale dayTrades count. Refresh it now.
      lastSignal.dayTrades = botState.dayTrades;

      const nyTime = new Date(lastSignal.time).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
      });

      const msg =
        `🚨 <b>${sig} SIGNAL — ${CONFIG.SYMBOL_MT5}</b>\n` +
        `🕒 Time: ${nyTime} (NY)\n` +
        `📈 Entry: ${lastSignal.entry} <i>(incl. ${CONFIG.SPREAD} spread, as of last closed candle)</i>\n` +
        `🛑 SL: ${lastSignal.stopLoss}\n` +
        `🎯 TP: ${lastSignal.takeProfit}\n` +
        `📦 Lot: ${lastSignal.lotSize}\n` +
        `📊 Confidence: ${confidence}%\n` +
        `📅 Trade ${botState.dayTrades}/${CONFIG.MAX_TRADES_DAY} today`;

      sendTelegram(msg).catch((e) => console.error("Telegram alert failed:", e.message));
    }
  }
}

// ---------------------------------------------------------------
// ERROR HANDLING
// ---------------------------------------------------------------
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
  process.exit(1);
});

// ---------------------------------------------------------------
// ENTRYPOINT + TEST EXPORTS
// ---------------------------------------------------------------
if (require.main === module) {
  start();
}

module.exports = {
  app,
  CONFIG,
  analyze,
  scoreTimeframe,
  marketOpenNY,
  zonedTimeToUtc,
  todayKey,
  fetchSeries,
  loadState,
  saveState,
  sendTelegram,
  estCreditsPerDay,
  checkTradeOutcome,
  formatOutcome,
  isAuthed,
  safeEqual,
  _getState: () => ({ botState, lastAlertedSignalKey, lastSignal, pollCount, lastCandleAgeMin }),
  _setCandles: (arr) => { candles = arr; },
  _setState: (s) => {
    if (s.botState) botState = s.botState;
    if ("lastAlertedSignalKey" in s) lastAlertedSignalKey = s.lastAlertedSignalKey;
  },
};
