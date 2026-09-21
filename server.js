/**
 * Structure-based trading signal bot (Telegram)
 *
 * Ye bot real OHLC candles fetch karta hai aur deterministic rules se
 * setup detect karta hai: swing structure -> BOS -> order block retest.
 * Koi random direction nahi, koi fake confidence score nahi.
 *
 * ZAROORI: Ye trading advice nahi hai. Logic ko pehle historical data par
 * backtest karo. Live paisa lagane se pehle demo account par chalao.
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs/promises');
const path = require('path');

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const CONFIG = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  dataApiKey: process.env.TWELVEDATA_API_KEY,
  apiSecret: process.env.API_SECRET,

  accountBalance: parseFloat(process.env.ACCOUNT_BALANCE || '500'),
  riskPercent: parseFloat(process.env.RISK_PERCENT || '1.0'),
  rewardRatio: parseFloat(process.env.REWARD_RATIO || '2.0'),

  interval: process.env.CANDLE_INTERVAL || '15min',
  candleCount: 200,

  scanIntervalMs: 5 * 60 * 1000,      // har 5 min scan
  monitorIntervalMs: 60 * 1000,       // har 1 min monitor
  cooldownMs: 4 * 60 * 60 * 1000,     // ek symbol par dobara signal se pehle gap
  maxConcurrentSignals: 3,

  statePath: path.join(__dirname, 'state.json'),
  port: process.env.PORT || 3000,
};

// Contract specs. contractSize = 1 lot me kitni units.
// USD-quoted pair ke liye: 1.0 price move par profit/loss = lots * contractSize.
// NOTE: ye typical MT4/MT5 values hain. APNE BROKER SE CONFIRM KARO.
const INSTRUMENTS = [
  { symbol: 'XAU/USD', label: 'GOLD (XAU/USD)', digits: 2, contractSize: 100,    minLot: 0.01, lotStep: 0.01 },
  { symbol: 'EUR/USD', label: 'EUR/USD',        digits: 5, contractSize: 100000, minLot: 0.01, lotStep: 0.01 },
  { symbol: 'GBP/USD', label: 'GBP/USD',        digits: 5, contractSize: 100000, minLot: 0.01, lotStep: 0.01 },
];

// ---------------------------------------------------------------------------
// STARTUP VALIDATION  (bug #9: pehle bot chalta rehta tha aur silently fail hota tha)
// ---------------------------------------------------------------------------

function validateConfig() {
  const missing = [];
  if (!CONFIG.telegramToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!CONFIG.telegramChatId) missing.push('TELEGRAM_CHAT_ID');
  if (!CONFIG.dataApiKey) missing.push('TWELVEDATA_API_KEY');
  if (!CONFIG.apiSecret) missing.push('API_SECRET');

  if (missing.length) {
    console.error('FATAL: missing env vars -> ' + missing.join(', '));
    process.exit(1);
  }
  if (!(CONFIG.accountBalance > 0)) {
    console.error('FATAL: ACCOUNT_BALANCE invalid');
    process.exit(1);
  }
  if (!(CONFIG.riskPercent > 0 && CONFIG.riskPercent <= 5)) {
    console.error('FATAL: RISK_PERCENT 0 se 5 ke beech hona chahiye');
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// STATE  (bug #6: pehle sab memory me tha, restart par ud jaata tha)
// ---------------------------------------------------------------------------

let state = { counter: 1, activeSignals: [], lastSignalAt: {} };

async function loadState() {
  try {
    const raw = await fs.readFile(CONFIG.statePath, 'utf8');
    const parsed = JSON.parse(raw);
    state = {
      counter: parsed.counter || 1,
      activeSignals: Array.isArray(parsed.activeSignals) ? parsed.activeSignals : [],
      lastSignalAt: parsed.lastSignalAt || {},
    };
    console.log(`State loaded: ${state.activeSignals.length} active signal(s).`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('State load error:', err.message);
    console.log('Fresh state se start kar rahe hain.');
  }
}

async function saveState() {
  try {
    const tmp = CONFIG.statePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(state, null, 2));
    await fs.rename(tmp, CONFIG.statePath); // atomic write
  } catch (err) {
    console.error('State save error:', err.message);
  }
}

// ---------------------------------------------------------------------------
// TELEGRAM
// ---------------------------------------------------------------------------

async function sendTelegramAlert(message) {
  const url = `https://api.telegram.org/bot${CONFIG.telegramToken}/sendMessage`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await axios.post(url, {
        chat_id: CONFIG.telegramChatId,
        text: message,
        parse_mode: 'Markdown',
      }, { timeout: 10000 });
      return true;
    } catch (error) {
      const detail = error.response?.data?.description || error.message;
      console.error(`Telegram attempt ${attempt} failed: ${detail}`);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// MARKET DATA  (bug #3: pehle EUR/USD, GBP/USD, BTC hardcoded the -> bot freeze)
// ---------------------------------------------------------------------------

const candleCache = new Map(); // symbol -> { at, candles }

async function fetchCandles(symbol) {
  const cached = candleCache.get(symbol);
  if (cached && Date.now() - cached.at < 60 * 1000) return cached.candles;

  const res = await axios.get('https://api.twelvedata.com/time_series', {
    params: {
      symbol,
      interval: CONFIG.interval,
      outputsize: CONFIG.candleCount,
      apikey: CONFIG.dataApiKey,
    },
    timeout: 10000,
  });

  if (res.data?.status === 'error') {
    throw new Error(`Data API: ${res.data.message}`);
  }
  if (!Array.isArray(res.data?.values) || res.data.values.length < 60) {
    throw new Error(`${symbol}: not enough candles returned`);
  }

  // API newest-first deti hai; humein oldest-first chahiye
  const candles = res.data.values
    .map((v) => ({
      time: v.datetime,
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
    }))
    .filter((c) => [c.open, c.high, c.low, c.close].every((n) => Number.isFinite(n) && n > 0))
    .reverse();

  candleCache.set(symbol, { at: Date.now(), candles });
  return candles;
}

async function getLivePrice(symbol) {
  const candles = await fetchCandles(symbol);
  return candles[candles.length - 1].close;
}

// ---------------------------------------------------------------------------
// INDICATORS
// ---------------------------------------------------------------------------

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  return sum / period;
}

/** Pivot swing points: left/right bars se confirm hote hain. */
function findSwings(candles, lookback = 3) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high });
    if (isLow) lows.push({ index: i, price: candles[i].low });
  }
  return { highs, lows };
}

/** BOS ke baad wala order block: impulse se pehle ka aakhri opposite candle. */
function findOrderBlock(candles, breakIndex, direction) {
  for (let i = breakIndex; i >= Math.max(0, breakIndex - 15); i--) {
    const c = candles[i];
    const isDown = c.close < c.open;
    const isUp = c.close > c.open;
    if ((direction === 'BUY' && isDown) || (direction === 'SELL' && isUp)) {
      return { index: i, high: c.high, low: c.low };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// STRATEGY  (bug #1: yahi wo hissa tha jo pehle Math.random() tha)
// ---------------------------------------------------------------------------

function detectSetup(candles) {
  const a = atr(candles, 14);
  if (!a || a <= 0) return null;

  const { highs, lows } = findSwings(candles, 3);
  if (highs.length < 2 || lows.length < 2) return null;

  const lastHigh = highs[highs.length - 1];
  const lastLow = lows[lows.length - 1];
  const last = candles[candles.length - 1];
  const price = last.close;

  // --- Bullish: recent close ne swing high tod diya (BOS up) ---
  let breakIndex = -1;
  for (let i = lastHigh.index + 1; i < candles.length; i++) {
    if (candles[i].close > lastHigh.price) { breakIndex = i; break; }
  }
  if (breakIndex !== -1 && candles.length - breakIndex <= 12) {
    const ob = findOrderBlock(candles, breakIndex - 1, 'BUY');
    // Entry tabhi jab price wapas OB zone me aaya ho (mitigation)
    if (ob && price <= ob.high && price >= ob.low - 0.25 * a) {
      const sl = ob.low - 0.25 * a;
      const risk = price - sl;
      if (risk > 0.1 * a) {
        return {
          direction: 'BUY',
          entry: price,
          sl,
          tp: price + risk * CONFIG.rewardRatio,
          reason: `BOS up above ${lastHigh.price.toFixed(5)}, OB retest`,
          atr: a,
        };
      }
    }
  }

  // --- Bearish: recent close ne swing low tod diya (BOS down) ---
  breakIndex = -1;
  for (let i = lastLow.index + 1; i < candles.length; i++) {
    if (candles[i].close < lastLow.price) { breakIndex = i; break; }
  }
  if (breakIndex !== -1 && candles.length - breakIndex <= 12) {
    const ob = findOrderBlock(candles, breakIndex - 1, 'SELL');
    if (ob && price >= ob.low && price <= ob.high + 0.25 * a) {
      const sl = ob.high + 0.25 * a;
      const risk = sl - price;
      if (risk > 0.1 * a) {
        return {
          direction: 'SELL',
          entry: price,
          sl,
          tp: price - risk * CONFIG.rewardRatio,
          reason: `BOS down below ${lastLow.price.toFixed(5)}, OB retest`,
          atr: a,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// POSITION SIZING  (bug #4: purana formula 10x galat risk deta tha)
// ---------------------------------------------------------------------------

function calculateLotSize(instrument, slDistance) {
  const riskUSD = CONFIG.accountBalance * (CONFIG.riskPercent / 100);
  const lossPerLot = slDistance * instrument.contractSize;
  if (!(lossPerLot > 0)) return null;

  const raw = riskUSD / lossPerLot;
  const steps = Math.floor(raw / instrument.lotStep);
  const lots = parseFloat((steps * instrument.lotStep).toFixed(2));

  if (lots < instrument.minLot) {
    // Min lot par bhi risk target se zyada hoga -> trade skip
    const forcedRisk = instrument.minLot * lossPerLot;
    return { lots: instrument.minLot, riskUSD: forcedRisk, exceedsRisk: forcedRisk > riskUSD };
  }
  return { lots, riskUSD: lots * lossPerLot, exceedsRisk: false };
}

// ---------------------------------------------------------------------------
// SCANNER
// ---------------------------------------------------------------------------

let scanning = false; // bug #8: overlapping runs rokne ke liye

async function scanMarkets() {
  if (scanning) { console.log('Previous scan abhi chal raha hai, skip.'); return; }
  scanning = true;

  try {
    if (state.activeSignals.length >= CONFIG.maxConcurrentSignals) {
      console.log('Max concurrent signals reached.');
      return;
    }

    for (const instrument of INSTRUMENTS) {
      // bug #12: same symbol par spam rokna
      const last = state.lastSignalAt[instrument.symbol] || 0;
      if (Date.now() - last < CONFIG.cooldownMs) continue;
      if (state.activeSignals.some((s) => s.symbol === instrument.symbol)) continue;
      if (state.activeSignals.length >= CONFIG.maxConcurrentSignals) break;

      try {
        const candles = await fetchCandles(instrument.symbol);
        const setup = detectSetup(candles);
        if (!setup) { console.log(`${instrument.symbol}: no valid setup.`); continue; }

        const slDistance = Math.abs(setup.entry - setup.sl);
        const sizing = calculateLotSize(instrument, slDistance);
        if (!sizing) continue;
        if (sizing.exceedsRisk) {
          console.log(`${instrument.symbol}: min lot par risk limit cross -> skip.`);
          continue;
        }

        const id = `SIG-${String(state.counter++).padStart(4, '0')}`;
        const d = instrument.digits;

        const message =
          `📊 *STRUCTURE SIGNAL*\n\n` +
          `🆔 ID: ${id}\n` +
          `🔹 Asset: ${instrument.label}\n` +
          `⏱ Timeframe: ${CONFIG.interval}\n` +
          `📈 Direction: ${setup.direction === 'BUY' ? 'BUY 🟢' : 'SELL 🔴'}\n\n` +
          `📍 Entry: ${setup.entry.toFixed(d)}\n` +
          `🛑 Stop Loss: ${setup.sl.toFixed(d)}\n` +
          `🎯 Take Profit: ${setup.tp.toFixed(d)}\n` +
          `💰 R:R — 1:${CONFIG.rewardRatio}\n\n` +
          `⚖️ Lot size: ${sizing.lots} (risk ≈ $${sizing.riskUSD.toFixed(2)} ` +
          `on $${CONFIG.accountBalance} @ ${CONFIG.riskPercent}%)\n` +
          `🧩 Rule matched: ${setup.reason}\n\n` +
          `_Rule-based output, not financial advice. Spread/slippage included nahi hai — ` +
          `apna risk khud verify karo._`;

        const sent = await sendTelegramAlert(message);
        if (sent) {
          state.activeSignals.push({
            id,
            symbol: instrument.symbol,
            label: instrument.label,
            digits: d,
            direction: setup.direction,
            entry: setup.entry,
            sl: setup.sl,
            tp: setup.tp,
            lots: sizing.lots,
            openedAt: Date.now(),
          });
          state.lastSignalAt[instrument.symbol] = Date.now();
          await saveState();
          console.log(`${id} sent for ${instrument.symbol}.`);
        } else {
          state.counter--; // Telegram fail -> ID waste mat karo
        }
      } catch (err) {
        // bug #7: ek symbol fail ho to baaki ruknay nahi chahiye
        console.error(`Scan error [${instrument.symbol}]:`, err.message);
      }
    }
  } finally {
    scanning = false;
  }
}

// ---------------------------------------------------------------------------
// MONITOR
// ---------------------------------------------------------------------------

let monitoring = false;

async function monitorSignals() {
  if (monitoring || state.activeSignals.length === 0) return;
  monitoring = true;

  try {
    for (let i = state.activeSignals.length - 1; i >= 0; i--) {
      const sig = state.activeSignals[i];
      try {
        const candles = await fetchCandles(sig.symbol);
        const recent = candles.slice(-4); // 60s polling me price miss na ho

        let outcome = null;
        for (const c of recent) {
          if (c.time && sig.openedAt && new Date(c.time).getTime() < sig.openedAt - 60000) continue;
          if (sig.direction === 'BUY') {
            if (c.low <= sig.sl) { outcome = 'SL'; break; }
            if (c.high >= sig.tp) { outcome = 'TP'; break; }
          } else {
            if (c.high >= sig.sl) { outcome = 'SL'; break; }
            if (c.low <= sig.tp) { outcome = 'TP'; break; }
          }
        }

        if (!outcome) continue;

        const risk = Math.abs(sig.entry - sig.sl) * sig.lots;
        const pnl = outcome === 'TP'
          ? risk * CONFIG.rewardRatio
          : -risk;

        const msg = outcome === 'TP'
          ? `🎯 *TARGET HIT*\nID: ${sig.id}\nAsset: ${sig.label}\n` +
            `Direction: ${sig.direction}\nEntry ${sig.entry.toFixed(sig.digits)} → TP ${sig.tp.toFixed(sig.digits)}`
          : `🛑 *STOP LOSS HIT*\nID: ${sig.id}\nAsset: ${sig.label}\n` +
            `Direction: ${sig.direction}\nEntry ${sig.entry.toFixed(sig.digits)} → SL ${sig.sl.toFixed(sig.digits)}`;

        await sendTelegramAlert(msg);
        state.activeSignals.splice(i, 1);
        await saveState();
        console.log(`${sig.id} closed: ${outcome} (est. ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} units)`);
      } catch (err) {
        console.error(`Monitor error [${sig.id}]:`, err.message);
      }
    }
  } finally {
    monitoring = false;
  }
}

// ---------------------------------------------------------------------------
// SCHEDULER  (bug #8: setInterval async ko await nahi karta tha)
// ---------------------------------------------------------------------------

function startLoop(fn, intervalMs, name) {
  const run = async () => {
    try { await fn(); }
    catch (err) { console.error(`${name} loop error:`, err.message); }
    finally { setTimeout(run, intervalMs); }
  };
  setTimeout(run, 3000);
}

// ---------------------------------------------------------------------------
// HTTP  (bug #5: /api/test-signal bilkul open tha)
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(cors({ origin: false })); // browser se koi cross-origin access nahi

function requireAuth(req, res, next) {
  const key = req.get('x-api-key');
  if (!key || key !== CONFIG.apiSecret) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, activeSignals: state.activeSignals.length, uptime: process.uptime() });
});

app.get('/api/signals', requireAuth, (_req, res) => {
  res.json({ success: true, signals: state.activeSignals });
});

app.post('/api/scan', requireAuth, async (_req, res) => {
  await scanMarkets();
  res.json({ success: true, activeSignals: state.activeSignals.length });
});

// ---------------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------------

(async () => {
  validateConfig();
  await loadState();

  app.listen(CONFIG.port, () => {
    console.log(`Signal bot listening on port ${CONFIG.port}`);
    console.log(`Balance $${CONFIG.accountBalance} | risk ${CONFIG.riskPercent}% | R:R 1:${CONFIG.rewardRatio} | TF ${CONFIG.interval}`);
  });

  startLoop(scanMarkets, CONFIG.scanIntervalMs, 'scan');
  startLoop(monitorSignals, CONFIG.monitorIntervalMs, 'monitor');
})();

process.on('SIGTERM', async () => { await saveState(); process.exit(0); });
process.on('SIGINT', async () => { await saveState(); process.exit(0); });
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err?.message || err));
