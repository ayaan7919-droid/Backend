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
        await axios.post(url, { 
            chat_id: TELEGRAM_CHAT_ID, 
            text: message,
            parse_mode: 'Markdown'
        });
        console.log("MT5-Synced Telegram alert sent successfully.");
        return true;
    } catch (error) {
        console.error("Telegram API Error:", error.message);
        return false;
    }
}

// --- NAYA MT5 WEBHOOK RECEIVER (Step 1) ---
app.post('/api/mt5-webhook', async (req, res) => {
    try {
        const { asset, price, trend } = req.body;
        
        if (!asset || !price || !trend) {
            return res.status(400).json({ error: "Invalid data from MT5" });
        }

        console.log(`Live Data Received - Asset: ${asset}, Price: ${price}, Trend: ${trend}`);

        let entry = parseFloat(price);
        let sl, tp;
        
        // Exact 100% Real MT5 Trend Based Direction
        let action = trend === "BULLISH" ? "BUY (LONG) 🟢" : "SELL (SHORT) 🔴";
        
        // Exact 1:3.5 SMC Math Strict Lock
        let riskBuffer = 6.50;  
        let rewardTarget = 22.75; 

        if (action.includes("BUY")) {
            sl = entry - riskBuffer;
            tp = entry + rewardTarget;
        } else {
            sl = entry + riskBuffer;
            tp = entry - rewardTarget;
        }

        const alertMessage = 
            `👑 *VIP MT5-SYNCED SMC SIGNAL* 👑\n\n` +
            `📊 *Setup:* Real Market Structure Alignment\n` +
            `🔹 *Asset:* ${asset} 🔥\n` +
            `📈 *Direction:* ${action}\n` +
            `📍 *MT5 Exact Entry:* $${entry.toFixed(2)}\n\n` +
            `🎯 *Take Profit (TP):* $${tp.toFixed(2)}\n` +
            `🛑 *Stop Loss (SL):* $${sl.toFixed(2)}\n\n` +
            `💰 *Risk-to-Reward:* 1:3.5 (Strict Protected)\n` +
            `⚡ *Live Broker Sync:* Active\n` +
            `⚙️ *Terminal ID:* ${MT5_ACCOUNT_ID}`;

        await sendTelegramAlert(alertMessage);
        res.status(200).json({ success: true, message: "Signal processed successfully!" });

    } catch (error) {
        console.error("Webhook Error:", error.message);
        res.status(500).json({ error: "Failed to process MT5 data" });
    }
});

// Test Endpoint Check
app.get('/api/test-signal', (req, res) => {
    res.send("Bot is running and waiting for MT5 live connection!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MT5 Webhook SMC Server running on port ${PORT}`);
});
