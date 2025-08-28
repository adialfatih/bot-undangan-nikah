import express from "express";
import { WebSocketServer } from "ws";
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
//import { Client, LocalAuth } from "whatsapp-web.js";
import QR from "qrcode";
import pkg from "whatsapp-web.js";
import { initSchema, getUserByWa, createUser } from "./src/db.js";
import { handleMessage } from "./src/handlers/messageHandler.js";
const { Client, LocalAuth } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const awaitingName = new Map(); // key: nomor_wa, value: true

const PORT = 3005;
const SESSION_DIR = path.join(__dirname, "session");       // penyimpanan sesi bot
const CACHE_DIR = path.join(__dirname, ".wwebjs_cache");   // cache chromium whatsapp-web.js

// Helper hapus folder recursive
function rmrf(p) {
    if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
    }
}
function extractNumber(waJid) {
    // contoh msg.from: "628123456789@s.whatsapp.net"
    return (waJid || "").split("@")[0];
}
function pad(n) { return n.toString().padStart(2, "0"); }
function formatAsiaJakartaDateTime(dt = new Date()) {
    // format: Y-m-d H:i:s pada zona Asia/Jakarta
    const idTime = new Date(dt.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
    const y = idTime.getFullYear();
    const m = pad(idTime.getMonth() + 1);
    const d = pad(idTime.getDate());
    const hh = pad(idTime.getHours());
    const mm = pad(idTime.getMinutes());
    const ss = pad(idTime.getSeconds());
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

// ------ Express ------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ------ WebSocket (untuk QR & log realtime ke browser) ------
const server = app.listen(PORT, () => {
    console.log(`HTTP running at http://localhost:${PORT}`);
});
const wss = new WebSocketServer({ server });
const clients = new Set();

function wsBroadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of clients) {
        if (ws.readyState === 1) ws.send(msg);
    }
}

wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
});

// ------ WhatsApp Client ------
let client = null;
await initSchema();
wsBroadcast({ type: "log", message: "DB connected & schema ready." });


function startClient() {
    client = new Client({
        authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
        puppeteer: {
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"]
        }
    });

    // client.on("qr", (qr) => {
    //     wsBroadcast({ type: "qr", qr });
    //     wsBroadcast({ type: "log", message: "QR code generated. Scan dengan WhatsApp." });
    //     console.log("QR generated");
    // });
    client.on("qr", async (qr) => {
        wsBroadcast({ type: "log", message: "QR code generated. Scan dengan WhatsApp." });
        try {
            const dataUrl = await QR.toDataURL(qr); // buat image base64
            wsBroadcast({ type: "qr_dataurl", dataUrl });
        } catch (e) {
            wsBroadcast({ type: "log", message: "Gagal generate QR (dataurl): " + e.message });
            // fallback: kirim raw text juga
            wsBroadcast({ type: "qr", qr });
        }
    });


    client.on("loading_screen", (percent, message) => {
        wsBroadcast({ type: "log", message: `Loading ${percent}% - ${message}` });
    });

    client.on("authenticated", () => {
        wsBroadcast({ type: "log", message: "Authenticated ✅" });
    });

    client.on("auth_failure", (msg) => {
        wsBroadcast({ type: "log", message: `Auth failure: ${msg}` });
    });

    client.on("ready", () => {
        wsBroadcast({ type: "log", message: "WhatsApp client is ready 🎉" });
    });

    // Logic bot sederhana
    client.on("message", async (msg) => {
        await handleMessage(client, msg, wsBroadcast);
    });

    client.initialize().catch((e) => {
        wsBroadcast({ type: "log", message: `Init error: ${e.message}` });
        console.error(e);
    });
}

// Endpoint Logout: hapus sesi & cache, reinit client
app.post("/logout", async (req, res) => {
    try {
        wsBroadcast({ type: "log", message: "Proses logout dimulai..." });
        if (client) {
            try { await client.logout(); } catch { }
            try { await client.destroy(); } catch { }
            client = null;
        }
        rmrf(SESSION_DIR);
        rmrf(CACHE_DIR);
        wsBroadcast({ type: "log", message: "Session & cache dihapus. Silakan scan QR baru." });

        // start ulang client untuk memunculkan QR baru
        startClient();
        return res.json({ ok: true });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// Mulai client pertama kali
startClient();
