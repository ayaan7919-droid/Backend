const express = require('express');
const axios = require('axios');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MT5_ACCOUNT_ID = process.env.MT5_ACCOUNT_ID || "112919690";

async function sendTelegramAlert(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.error("ERROR: Telegram Bot Token or Chat ID is missing!");
        return false;
    }
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const response = await axios.post(url, { 
            chat_id: TELEGRAM_CHAT_ID, 
            text: message,
            parse_mode: 'Markdown'
        });
        console.log("Telegram alert sent successfully:", response.data);
        return true;
    } catch (error) {
        console.error("Telegram API Error Response:", error.response?.data || error.message);
        return false;
    }
}

// 1. TradingView Webhook Endpoint (Jab market structure banega, TradingView yahan signal bhejega)
app.post('/api/webhook', async (req, res) => {
    try {
        const alertData = req.body;
        console.log("Received TradingView Alert:", alertData);

        // TradingView se aane wala data decode karna
        const asset = alertData.asset || "GOLD (XAU/USD)";
        const action = alertData.action || "BUY (LONG)";
        const entry = alertData.entry || "2650.00";
        const tp = alertData.tp || "2665.00";
        const sl = alertData.sl || "2645.00";
        const setup = alertData.setup || "Market Structure Break (BOS) + Order Block";

        const alertMessage = 
            `👑 *VIP INSTITUTIONAL MARKET STRUCTURE SIGNAL* 👑\n\n` +
            `📊 *Setup:* ${setup}\n` +
            `🔹 *Asset:* ${asset}\n` +
            `📈 *Direction:* ${action.includes('BUY') ? 'BUY (LONG) 🟢' : 'SELL (SHORT) 🔴'}\n` +
            `📍 *Live Chart Entry:* $${entry}\n\n` +
            `🎯 *Take Profit (TP):* $${tp}\n` +
            `🛑 *Stop Loss (SL):* $${sl}\n\n` +
            `💰 *Risk-to-Reward:* 1:3.0 (Strict SMC Execution)\n` +
            `⚡ *Linked Terminal ID:* ${MT5_ACCOUNT_ID}`;

        const sent = await sendTelegramAlert(alertMessage);

        if (sent) {
            res.status(200).json({ success: true, message: "Webhook processed and signal sent to Telegram!" });
        } else {
            res.status(500).json({ success: false, message: "Webhook received, but Telegram failed." });
        }
    } catch (error) {
        console.error("Webhook Error:", error.message);
        res.status(400).json({ success: false, message: "Invalid payload format" });
    }
});

// 2. Manual Testing Endpoint
app.get('/api/test-signal', async (req, res) => {
    const testMessage = 
        `👑 *VIP INSTITUTIONAL GOLD SIGNAL (TEST)* 👑\n\n` +
        `📊 *Setup:* Market Structure Break (BOS) + Order Block\n` +
        `🔹 *Asset:* GOLD (XAU/USD) 🔥\n` +
        `📈 *Direction:* BUY (LONG) 🟢\n` +
        `📍 *Live Chart Entry:* $2650.00\n\n` +
        `🎯 *Take Profit (TP):* $2665.00\n` +
        `🛑 *Stop Loss (SL):* $2645.00\n\n` +
        `💰 *Risk-to-Reward:* 1:3.0\n` +
        `⚡ *Linked Terminal ID:* ${MT5_ACCOUNT_ID}`;

    const result = await sendTelegramAlert(testMessage);
    if (result) {
        res.json({ success: true, message: "Test SMC Signal successfully sent to Telegram!" });
    } else {
        res.json({ success: false, message: "Failed. Check Railway logs." });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`TradingView Webhook SMC Server running on port ${PORT}`);
});
