// ⬇️ tambahkan import ini
import pkg from "whatsapp-web.js";
const { MessageMedia } = pkg;

import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Lokasi file undangan (handler ada di: src/handlers)
// → ../../public/img/undangan.png
const INVITE_IMG = path.resolve(__dirname, "../../public/img/undangan.png");

import { getUserByWa, createUser } from "../db.js";

// state sementara utk pendaftaran
const awaitingName = new Map();

function extractNumber(waJid) {
    return (waJid || "").split("@")[0];
}
function pad(n) { return n.toString().padStart(2, "0"); }
function formatAsiaJakartaDateTime(dt = new Date()) {
    const idTime = new Date(dt.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
    const y = idTime.getFullYear();
    const m = pad(idTime.getMonth() + 1);
    const d = pad(idTime.getDate());
    const hh = pad(idTime.getHours());
    const mm = pad(idTime.getMinutes());
    const ss = pad(idTime.getSeconds());
    return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

/**
 * Handler utama pesan WhatsApp
 * @param {Client} client - instance whatsapp-web.js
 * @param {object} msg - pesan WhatsApp
 * @param {function} wsBroadcast - untuk broadcast log ke WebSocket UI
 */
export async function handleMessage(client, msg, wsBroadcast) {
    const fullText = (msg.body || "").trim();
    const text = fullText.toLowerCase();
    const fromNumber = extractNumber(msg.from);
    wsBroadcast({ type: "log", message: `Pesan diterima dari ${msg.from}: ${msg.body}` });

    try {
        const user = await getUserByWa(fromNumber);

        // 1) Jika user sedang diminta mengirim nama (awaitingName)
        if (awaitingName.has(fromNumber)) {
            const nama = fullText.trim();
            if (!nama) {
                await client.sendMessage(msg.from, "Nama tidak boleh kosong. Silakan masukan nama anda:");
                return;
            }
            // simpan ke DB
            const created_at = formatAsiaJakartaDateTime();
            try {
                await createUser({ nomor_wa: fromNumber, nama, created_at });
                awaitingName.delete(fromNumber);
                await client.sendMessage(msg.from, `Terima kasih, *${nama}*. Pendaftaran berhasil ✅\nDi tunggu kehadirannya ya di acara pernikahan Kak Rahmat dan Kak Ayu pada hari Senin, 12 Robiul Awal 1446H\nBertempat di : Ballroom Hotel Dafam Pekalongan.\nJl. Urip Sumoharjo No.26 Kota Pekalongan`);
            } catch (e) {
                awaitingName.delete(fromNumber);
                // Bisa jadi race/duplikat insert
                await client.sendMessage(msg.from, "Terjadi kesalahan saat mendaftar atau nomor sudah terdaftar.");
            }
            return; // hentikan di sini; tidak lanjut ke logic "halo/hi"
        }

        // 2) Jika mengetik "daftar"
        if (text === "daftar") {
            if (user) {
                await client.sendMessage(
                    msg.from,
                    `Hi kak *${user.nama || "(tanpa nama)"}*. Nomor anda telah terdaftar.\n\nKetik *jadwa acara* untuk melihat tanggal dan waktu acara.\nKetik *lokasi* untuk melihat lokasi acara diselenggarakan.`
                );
            } else {
                awaitingName.set(fromNumber, true);
                await client.sendMessage(msg.from, "Silahkan masukan nama anda:");
            }
            return;
        }

        // 3) Jika user belum terdaftar → minta daftar (apapun pesan yang dikirim)
        if (!user) {
            try {
                const media = MessageMedia.fromFilePath(INVITE_IMG);
                await client.sendMessage(msg.from, media);
            } catch (e) {
                // Jika file tak ditemukan, tetap lanjutkan pesan teks
                wsBroadcast({ type: "log", message: `Gagal kirim gambar undangan: ${e.message}` });
            }

            const isHi = text === "hi";
            const isHalo = text === "halo";
            const greet = isHi ? "hi" : (isHalo ? "halo" : "halo");

            await client.sendMessage(
                msg.from,
                `${greet} juga, selamat datang, saya adalah *Ropin* robot pintar yang akan mengelola tamu undangan pada pernikahan Kak Rahmat dan Kak Ayu, apakah kamu ingin mendaftar sebagai tamu?\n\nKetik *daftar* jika anda bersedia untuk hadir sebagai tamu kehormatan kami.`
            );
            // Catatan: flow daftar tetap sama—user bisa balas "daftar" untuk lanjut registrasi
            return;
        }

        // ====== (USER TERDAFTAR) Logic bot lama tetap jalan di bawah ini ======

        if (text === "halo") {
            await client.sendMessage(msg.from, "halo juga");
            wsBroadcast({ type: "log", message: `Balas ke ${msg.from}: halo juga` });
        } else if (text === "hi") {
            await client.sendMessage(msg.from, "hi juga");
            wsBroadcast({ type: "log", message: `Balas ke ${msg.from}: hi juga` });
        }

    } catch (err) {
        wsBroadcast({ type: "log", message: `DB error: ${err.message}` });
    }
}