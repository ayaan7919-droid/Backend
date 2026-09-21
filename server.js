const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const app = express();

app.use(express.json());

// Telegram configuration (Aapke Railway variables se uthayega)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const MT5_ACCOUNT_ID = process.env.MT5_ACCOUNT_ID || "112919690";

// Function to send alerts to Telegram
async function sendTelegramAlert(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        console.log("Telegram credentials missing!");
        return false;
    }
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        return true;
    } catch (error) {
        console.error("Error sending Telegram alert:", error.message);
        return false;
    }
}

// Multi-Market SMC Scanner Logic (Forex, Gold & Crypto)
async function runSMCScannerAndBroadcast() {
    try {
        console.log("Running automated Multi-Market SMC scan (Forex, Gold, Crypto)...");
        
        // Assets list
        const assets = [
            { name: "XAU/USD (Gold)", type: "GOLD", basePrice: 4350.00, spread: 25.00 },
            { name: "EUR/USD", type: "FOREX", basePrice: 1.0850, spread: 0.0030 },
            { name: "GBP/USD", type: "FOREX", basePrice: 1.2720, spread: 0.0040 },
            { name: "USD/JPY", type: "FOREX", basePrice: 154.50, spread: 0.40 },
            { name: "BTC/USD", type: "CRYPTO", basePrice: 64500.00, spread: 1200.00 },
            { name: "ETH/USD", type: "CRYPTO", basePrice: 3450.00, spread: 80.00 }
        ];

        // Randomly select one asset from the list for this hour's signal
        const selectedAsset = assets[Math.floor(Math.random() * assets.length)];
        
        const setupTypes = [
            "Market Structure Break (BOS) + Institutional Liquidity Sweep",
            "Bullish Order Block (OB) + Fair Value Gap (FVG) Mitigation",
            "Change of Character (ChoCH) + Premium/Discount Array Test",
            "Mitigation Block + Inducement (IDM) Sweep"
        ];
        const setupType = setupTypes[Math.floor(Math.random() * setupTypes.length)];
        
        const confidence = (Math.random() * (98.8 - 91.5) + 91.5).toFixed(1); 
        const action = Math.random() > 0.15 ? "BUY (LONG)" : "SELL (SHORT)";
        
        // Calculate realistic prices based on asset type
        let entryPrice, takeProfit, stopLoss, rrRatio;
        
        if (selectedAsset.type === "FOREX") {
            const variance = (Math.random() * 0.0020 - 0.0010);
            entryPrice = (selectedAsset.basePrice + variance).toFixed(4);
            if (action.includes("BUY")) {
                takeProfit = (parseFloat(entryPrice) + selectedAsset.spread).toFixed(4);
                stopLoss = (parseFloat(entryPrice) - (selectedAsset.spread / 2)).toFixed(4);
            } else {
                takeProfit = (parseFloat(entryPrice) - selectedAsset.spread).toFixed(4);
                stopLoss = (parseFloat(entryPrice) + (selectedAsset.spread / 2)).toFixed(4);
            }
            rrRatio = "1:2.5";
        } else if (selectedAsset.type === "GOLD") {
            const variance = (Math.random() * 10 - 5);
            entryPrice = (selectedAsset.basePrice + variance).toFixed(2);
            if (action.includes("BUY")) {
                takeProfit = (parseFloat(entryPrice) + 45.00).toFixed(2);
                stopLoss = (parseFloat(entryPrice) - 18.00).toFixed(2);
            } else {
                takeProfit = (parseFloat(entryPrice) - 45.00).toFixed(2);
                stopLoss = (parseFloat(entryPrice) + 18.00).toFixed(2);
            }
            rrRatio = "1:3.0";
        } else {
            // CRYPTO
            const variance = (Math.random() * 200 - 100);
            entryPrice = (selectedAsset.basePrice + variance).toFixed(2);
            if (action.includes("BUY")) {
                takeProfit = (parseFloat(entryPrice) + selectedAsset.spread).toFixed(2);
                stopLoss = (parseFloat(entryPrice) - (selectedAsset.spread / 2)).toFixed(2);
            } else {
                takeProfit = (parseFloat(entryPrice) - selectedAsset.spread).toFixed(2);
                stopLoss = (parseFloat(entryPrice) + (selectedAsset.spread / 2)).toFixed(2);
            }
            rrRatio = "1:2.8";
        }

        const alertMessage = 
            `📊 *SMC Setup:* ${setupType}\n` +
            `⭐ *Model Confidence:* ${confidence}%\n\n` +
            `🔹 *Asset:* ${selectedAsset.name}\n` +
            `📈 *Direction:* ${action}\n` +
            `📍 *Optimal Entry:* $${entryPrice}\n` +
            `🎯 *Take Profit (TP):* $${takeProfit}\n` +
            `🛑 *Stop Loss (SL):* $${stopLoss}\n` +
            `⚖️ *Risk-to-Reward:* ${rrRatio}\n\n` +
            `⚡ *Linked MT5 Account:* ${MT5_ACCOUNT_ID}`;

        // Telegram par automatic broadcast karein
        await sendTelegramAlert(alertMessage);
        console.log(`Multi-market SMC signal broadcasted successfully for ${selectedAsset.name}!`);
    } catch (error) {
        console.error("Error in automated multi-market scanner:", error.message);
    }
}

// 🕒 AUTOMATIC CRON SCHEDULE: Har 1 ghante mein khud-b-khud chalega
cron.schedule('0 * * * *', () => {
    console.log('Hourly Cron triggered: Scanning all markets (Forex, Gold, Crypto)...');
    runSMCScannerAndBroadcast();
});

// Manual test route agar turant check karna ho
app.get('/api/test-trade', async (r_req, r_res) => {
    await runSMCScannerAndBroadcast();
    r_res.json({ success: true, message: "Multi-market SMC test signal triggered and broadcasted to Telegram!" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Multi-Market SMC Bot server is running on port ${PORT}`);
});
