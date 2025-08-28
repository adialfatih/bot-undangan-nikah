// ⬇️ tambahkan import ini
import pkg from "whatsapp-web.js";
const { MessageMedia } = pkg;

import path from "path";
import { fileURLToPath } from "url";
// QR decode & OCR
import { Jimp } from "jimp";

import QrCode from "qrcode-reader";
import Tesseract from "tesseract.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Lokasi file undangan (handler ada di: src/handlers)
// → ../../public/img/undangan.png
const INVITE_IMG = path.resolve(__dirname, "../../public/img/seminar.png");
const QRIS_IMG = path.resolve(__dirname, "../../public/img/qris.png");

//import { getUserByWa, createUser, createParticipant } from "../db.js";
import {
    getUserByWa, createUser, createParticipant,
    isAdmin, getParticipantByNominal, setPaidByNominal,
    getParticipantByWa, countParticipants, countPaidParticipants
} from "../db.js";

// state sementara utk pendaftaran
const awaitingName = new Map();
// ⬇️ NEW: state konfirmasi admin (key: nomor admin, val: {nominal, pesertaWa})
const adminPending = new Map();

function formatRupiah(n) {
    return Number(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
function code3FromId(id) {
    const n = Math.abs(Number(id || 0)) % 1000;
    return n.toString().padStart(3, "0"); // contoh: 1 -> "001"
}
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
    //const text = fullText.toLowerCase();
    const text = fullText.toLowerCase().replace(/\s+/g, " ").trim();
    const fromNumber = extractNumber(msg.from);
    wsBroadcast({ type: "log", message: `Pesan diterima dari ${msg.from}: ${msg.body}` });
    if (msg.type === "image" || msg.hasMedia) {
        try {
            const media = await msg.downloadMedia(); // whatsapp-web.js -> { mimetype, data(base64), filename? }
            if (!media || !media.data) {
                await client.sendMessage(msg.from, "Gambar tidak terbaca. Coba kirim ulang ya 🙏");
                return;
            }

            const buffer = Buffer.from(media.data, "base64");

            // 1) Coba decode QR
            let qrText = null;
            try {
                const image = await Jimp.read(buffer);

                const qr = new QrCode();
                qrText = await new Promise((resolve, reject) => {
                    qr.callback = (err, value) => {
                        if (err) return resolve(null);  // biarkan gagal senyap, lanjut OCR
                        resolve(value ? value.result : null);
                    };
                    qr.decode(image.bitmap);
                });
            } catch (_) {
                // ignore QR error, lanjut OCR
            }

            // 2) OCR untuk menangkap kode angka di bawah QR
            let ocrText = "";
            let detectedCode = null;
            try {
                const ocr = await Tesseract.recognize(buffer, "eng"); // angka latin OK
                ocrText = (ocr?.data?.text || "").replace(/[^\d]/g, " ").replace(/\s+/g, " ").trim();
                // ambil kandidat angka 3–6 digit (silakan ubah pola sesuai formatmu)
                const match = ocrText.match(/\b\d{3,6}\b/);
                detectedCode = match ? match[0] : null;
            } catch (e) {
                // OCR gagal → tetap lanjut balas berdasarkan QR saja (kalau ada)
            }

            // 3) Balas ke pengirim + log
            let reply = "";
            if (qrText) reply += `QR terdeteksi:\n${qrText}\n\n`;
            if (detectedCode) reply += `Kode terdeteksi: *${detectedCode}*\n`;
            if (!reply) reply = "Maaf, aku tidak menemukan QR atau kode angka yang jelas di gambar.\nCoba foto lebih dekat, terang, dan tidak blur ya 🙏";

            await client.sendMessage(msg.from, reply.trim());
            wsBroadcast({
                type: "log",
                message: `IMG processed from ${msg.from}: qr=${!!qrText} code=${detectedCode || "-"}`
            });

            return; // selesai untuk pesan gambar
        } catch (e) {
            wsBroadcast({ type: "log", message: `IMG error: ${e.message}` });
            await client.sendMessage(msg.from, "Terjadi kesalahan membaca gambar. Coba kirim ulang ya 🙏");
            return;
        }
    }
    //end jika menerima pesan gambar
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

                const userNow = await getUserByWa(fromNumber);
                const idUser = userNow?.id || 0;
                const kodeUnik = code3FromId(idUser);
                const nominal = 100000 + parseInt(kodeUnik, 10);
                const nominalStr = formatRupiah(nominal);
                try {
                    await createParticipant({
                        nomor_wa: fromNumber,
                        nominal_pembayaran: nominal,
                        status_bayar: "no",
                        status_hadir: "no",
                        status_voucher: "ready",
                        waktu_hadir: "no"
                    });
                    wsBroadcast({ type: "log", message: `Peserta upsert OK nomor=${fromNumber} nominal=${nominal}` });
                } catch (e) {
                    wsBroadcast({ type: "log", message: `DB peserta ERROR: ${e.code || e.message}` });
                }


                await client.sendMessage(msg.from, `Terima kasih, *${nama}*. Pendaftaran berhasil ✅\nAnda akan terdaftar sebagai peserta pada seminar "The Power Of PERSONAL BRANDING", yang akan di selenggarakan pada hari Senin, 12 September 2025\nBertempat di : Ballroom Hotel Dafam Pekalongan.\nJl. Urip Sumoharjo No.26 Kota Pekalongan.`);
                try {
                    const media = MessageMedia.fromFilePath(QRIS_IMG);
                    const caption = `Silahkan melakukan pembayaran melalui QRIS sebesar *Rp.${nominalStr}*. Pastikan menyertakan kode unik *${kodeUnik}* di dalam nominal pembayaran.`;
                    await client.sendMessage(msg.from, media, { caption });
                } catch (e) {
                    // Kalau file tidak ada atau gagal kirim media, tetap kirim nominal via teks
                    wsBroadcast({ type: "log", message: `Gagal kirim QRIS: ${e.message}` });
                    await client.sendMessage(
                        msg.from,
                        `Nominal pembayaran kamu (ID ${idUser}): *Rp.${nominalStr}*`
                    );
                }
            } catch (e) {
                awaitingName.delete(fromNumber);
                // Bisa jadi race/duplikat insert
                await client.sendMessage(msg.from, "Terjadi kesalahan saat mendaftar atau nomor sudah terdaftar.");
            }
            return; // hentikan di sini; tidak lanjut ke logic "halo/hi"
        }
        if (text === "status peserta") {
            // ADMIN → tampilkan agregat
            if (await isAdmin(fromNumber)) {
                const total = await countParticipants();
                const paid = await countPaidParticipants();
                const unpaid = Math.max(0, total - paid);

                await client.sendMessage(
                    msg.from,
                    `*Resume Total Peserta*\nSeminar "The Power Of PERSONAL BRANDING"\n\n` +
                    `Total terdaftar : *${total}*\n` +
                    `Sudah bayar     : *${paid}*\n` +
                    `Belum bayar     : *${unpaid}*`
                );
                return;
            }

            // NON-ADMIN → status dirinya sendiri
            const user = await getUserByWa(fromNumber);
            if (!user) {
                await client.sendMessage(msg.from, "Anda belum terdaftar ketik *daftar* untuk mendaftar");
                return;
            }

            const peserta = await getParticipantByWa(fromNumber);
            const payLabel = (peserta?.status_bayar === "yes") ? "Paid" : "Unpaid";

            await client.sendMessage(
                msg.from,
                `Anda terdaftar sebagai :\nNama : *${user.nama || "-"}*\n` +
                `Status pendaftaran : *Terdaftar*\n` +
                `Status pembayaran : *${payLabel}*\n\nSeminar\nThe Power Of "PERSONAL BRANDING"`
            );
            return;
        }
        // 2) Jika mengetik "daftar"
        if (text === "daftar") {
            if (user) {
                await client.sendMessage(
                    msg.from,
                    `Hi kak *${user.nama || "(tanpa nama)"}*. Nomor anda telah terdaftar.\n\nKetik *jadwa acara* untuk melihat tanggal dan waktu acara.\nKetik *lokasi* untuk melihat lokasi seminar.`
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
                wsBroadcast({ type: "log", message: `Gagal kirim gambar gambar: ${e.message}` });
            }

            const isHi = text === "hi";
            const isHalo = text === "halo";
            const greet = isHi ? "hi" : (isHalo ? "halo" : "halo");

            await client.sendMessage(
                msg.from,
                `${greet} juga, selamat datang, saya adalah *Ropin* robot pintar yang akan mengelola peserta pada seminar "The Power Of PERSONAL BRANDING", apakah kamu ingin mendaftar sebagai tamu?\n\nKetik *daftar* jika anda bersedia untuk hadir sebagai peserta.`
            );
            // Catatan: flow daftar tetap sama—user bisa balas "daftar" untuk lanjut registrasi
            return;
        }
        // ===== ADMIN FLOW: "konfirmasi <nominal>" & balasan "ya" =====
        const mKonfirmasi = /^konfirmasi\s+(\d{3,})$/i.exec(text);

        if (mKonfirmasi) {
            // jika pengirim bukan admin → tolak
            if (!(await isAdmin(fromNumber))) {
                await client.sendMessage(msg.from, "Anda tidak memiliki akses untuk konfirmasi.!");
                return;
            }

            const nominal = parseInt(mKonfirmasi[1], 10);
            const peserta = await getParticipantByNominal(nominal);

            if (!peserta) {
                await client.sendMessage(msg.from, `Data peserta dengan nominal Rp.${formatRupiah(nominal)} tidak ditemukan.`);
                return;
            }

            const userPeserta = await getUserByWa(peserta.nomor_wa);
            const namaPeserta = userPeserta?.nama || peserta.nomor_wa;

            // simpan pending konfirmasi untuk admin ini
            adminPending.set(fromNumber, { nominal, pesertaWa: peserta.nomor_wa });

            await client.sendMessage(
                msg.from,
                `Anda akan mengkonfirmasi pembayaran dari *${namaPeserta}* sebesar *Rp.${formatRupiah(nominal)}* ? ` +
                `balas *ya* untuk konfirmasi`
            );
            return;
        }

        // Admin balas "ya" untuk konfirmasi (hanya jika ada pending)
        if (text === "ya" && adminPending.has(fromNumber)) {
            // Pastikan pengirim admin
            if (!(await isAdmin(fromNumber))) {
                await client.sendMessage(msg.from, "Anda tidak memiliki akses untuk konfirmasi.!");
                return;
            }

            const pending = adminPending.get(fromNumber);
            const affected = await setPaidByNominal(pending.nominal);

            // bersihkan pending hanya jika 'ya' (jika balasan lain → tidak kita hapus, sesuai instruksi "tidak terjadi apa-apa")
            adminPending.delete(fromNumber);

            if (affected > 0) {
                const userPeserta = await getUserByWa(pending.pesertaWa);
                const namaPeserta = userPeserta?.nama || pending.pesertaWa;
                await client.sendMessage(
                    msg.from,
                    `Konfirmasi pembayaran *berhasil* untuk *${namaPeserta}* sebesar *Rp.${formatRupiah(pending.nominal)}* ✅`
                );
            } else {
                await client.sendMessage(msg.from, "Konfirmasi gagal: data tidak ditemukan/ sudah berubah.");
            }
            return;
        }

        // Jika non-admin mencoba pakai perintah "konfirmasi ..."
        if (/^konfirmasi\s+/i.test(text)) {
            await client.sendMessage(msg.from, "Anda tidak memiliki akses untuk konfirmasi.!");
            return;
        }
        if (text === "status peserta") {

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