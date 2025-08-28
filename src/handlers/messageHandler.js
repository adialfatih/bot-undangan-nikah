// ⬇️ tambahkan import ini
import jsQR from "jsqr";
import pkg from "whatsapp-web.js";
const { MessageMedia } = pkg;
import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";
// QR decode & OCR

import * as JimpNS from "jimp";
const Jimp = JimpNS.Jimp || JimpNS;

import QrCode from "qrcode-reader";
import {
    MultiFormatReader,
    BarcodeFormat,
    DecodeHintType,
    RGBLuminanceSource,
    BinaryBitmap,
    HybridBinarizer,
} from "@zxing/library";

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
    getParticipantByWa, countParticipants, countPaidParticipants,
    setAttendanceYes, setVoucherStatus,
    listHadirParticipants, countUnpaidParticipants,
    listPaidParticipants, listUnpaidParticipants   // ⬅️ tambah ini
} from "../db.js";


// state sementara utk pendaftaran
const awaitingName = new Map();
// ⬇️ NEW: state konfirmasi admin (key: nomor admin, val: {nominal, pesertaWa})
const adminPending = new Map();

function formatRupiah(n) {
    return Number(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
function log(wsBroadcast, msg) {
    try { wsBroadcast?.({ type: "log", message: msg }); } catch { }
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
async function decodeQR(buffer, wsBroadcast) {
    const base = await Jimp.read(buffer);
    const W = base.bitmap.width, H = base.bitmap.height;
    log(wsBroadcast, `QR: img size ${W}x${H}`);

    // Kandidat skala & rotasi & preprocess
    const widthTargets = [400, 600, 800, 1000, 1200, 1600];
    const rotations = [0, -7, 7, -12, 12, -17, 17];
    const preprocesses = [
        (img) => img.clone().greyscale().normalize().contrast(0.5),
        (img) => img.clone().greyscale().contrast(0.9),
        (img) => img.clone().greyscale().normalize().contrast(0.3).threshold({ max: 200 }),
        (img) => img.clone().greyscale().threshold({ max: 210 })
    ];

    // Jendela crop (biar QR kecil di pojok tetap kebaca)
    const crops = [
        { x: 0.00, y: 0.00, w: 1.00, h: 1.00 }, // full
        { x: 0.15, y: 0.15, w: 0.70, h: 0.70 }, // center
        { x: 0.00, y: 0.00, w: 0.60, h: 0.60 }, // TL
        { x: 0.40, y: 0.00, w: 0.60, h: 0.60 }, // TR
        { x: 0.00, y: 0.40, w: 0.60, h: 0.60 }, // BL
        { x: 0.40, y: 0.40, w: 0.60, h: 0.60 }, // BR
    ];

    // ZXing setup
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.QR_CODE]);
    hints.set(DecodeHintType.TRY_HARDER, true);
    const reader = new MultiFormatReader();
    reader.setHints(hints);

    const tryZX = (img) => {
        const { data, width, height } = img.bitmap; // RGBA
        const luminance = new RGBLuminanceSource(new Uint8ClampedArray(data), width, height);
        const binary = new BinaryBitmap(new HybridBinarizer(luminance));
        const result = reader.decode(binary);
        return result?.getText?.();
    };

    const tryJSQR = (img) => {
        const { data, width, height } = img.bitmap; // RGBA
        const out = jsQR(new Uint8ClampedArray(data), width, height);
        return out?.data || null;
    };

    const tryQRCodeReader = async (img) => {
        const qr = new QrCode();
        return await new Promise((resolve) => {
            try {
                qr.callback = (_err, value) => resolve(value?.result || null);
                qr.decode(img.bitmap);
            } catch { resolve(null); }
        });
    };

    // 1) Langsung di gambar asli: ZXing → jsQR → qrcode-reader
    try { const t = tryZX(base); if (t) return t; } catch { }
    { const t = tryJSQR(base); if (t) return t; }
    { const t = await tryQRCodeReader(base); if (t) return t; }

    // 2) Multi-scale + preprocess + rotasi + sliding window
    for (const wTarget of widthTargets) {
        const scaled = base.clone().resize(wTarget, Jimp.AUTO);
        for (const crop of crops) {
            const x = Math.floor(scaled.bitmap.width * crop.x);
            const y = Math.floor(scaled.bitmap.height * crop.y);
            const cw = Math.floor(scaled.bitmap.width * crop.w);
            const ch = Math.floor(scaled.bitmap.height * crop.h);
            const windowImg = scaled.clone().crop(x, y, cw, ch);

            for (const pp of preprocesses) {
                const pre = pp(windowImg);
                for (const deg of rotations) {
                    const img = deg ? pre.clone().rotate(deg, false) : pre;

                    try { const t = tryZX(img); if (t) return t; } catch { }
                    { const t = tryJSQR(img); if (t) return t; }
                    { const t = await tryQRCodeReader(img); if (t) return t; }
                }
            }
        }
    }

    return null;
}


async function ocrAllText(buffer, wsBroadcast) {
    try {
        const img = await Jimp.read(buffer);
        const h = img.bitmap.height, w = img.bitmap.width;

        // crop 35% area bawah (sering ada kode bawah QR)
        const cropped = img.clone().crop(0, Math.floor(h * 0.65), w, Math.floor(h * 0.35));
        const bufCropped = await cropped.getBufferAsync(Jimp.MIME_PNG);

        // Pass 1: cropped
        try {
            const r1 = await Tesseract.recognize(bufCropped, "eng");
            const t1 = (r1?.data?.text || "").trim();
            if (t1) return t1;
        } catch (e1) {
            wsBroadcast?.({ type: "log", message: `OCR cropped error: ${e1.message}` });
        }

        // Pass 2: full
        const bufFull = await img.getBufferAsync(Jimp.MIME_PNG);
        try {
            const r2 = await Tesseract.recognize(bufFull, "eng");
            return (r2?.data?.text || "").trim();
        } catch (e2) {
            wsBroadcast?.({ type: "log", message: `OCR full error: ${e2.message}` });
            return "";
        }
    } catch (e) {
        wsBroadcast?.({ type: "log", message: `OCR prepare error: ${e.message}` });
        return "";
    }
}

async function normalizeToPNG(base64Data, wsBroadcast) {
    const input = Buffer.from(base64Data, "base64");
    try {
        // autoRotate (EXIF), resize agar tidak terlalu kecil besar, konversi ke PNG
        const out = await sharp(input)
            .rotate() // auto-orient
            .resize(1200, 1200, { fit: "inside", withoutEnlargement: true })
            .png()
            .toBuffer();
        return out;
    } catch (e) {
        wsBroadcast?.({ type: "log", message: `IMG normalize error: ${e.message}` });
        return input; // fallback: pakai buffer asli
    }
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
        let media;
        try {
            media = await msg.downloadMedia();
            if (!media?.data) {
                await client.sendMessage(msg.from, "Gambar tidak terbaca. Coba kirim ulang ya 🙏");
                return;
            }
            log(wsBroadcast, `IMG mimetype=${media.mimetype || '-'} size=${(media.data.length / 1024).toFixed(1)}KB`);
        } catch (e) {
            log(wsBroadcast, `IMG download error: ${e.message}`);
            await client.sendMessage(msg.from, "Gambar tidak bisa diunduh. Coba kirim ulang ya 🙏");
            return;
        }

        const pngBuf = await normalizeToPNG(media.data, wsBroadcast);
        log(wsBroadcast, `IMG normalized size=${(pngBuf.length / 1024).toFixed(1)}KB`);

        let qrText = null; let ocrTextRaw = "";
        try {
            qrText = await decodeQR(pngBuf, wsBroadcast);
            log(wsBroadcast, `QR decode: ${qrText ? 'FOUND' : 'none'}`);
        } catch (e) {
            log(wsBroadcast, `QR decode error: ${e.message}`);
        }

        try {
            ocrTextRaw = await ocrAllText(pngBuf, wsBroadcast);
            log(wsBroadcast, `OCR length: ${ocrTextRaw?.length || 0}`);
        } catch (e) {
            log(wsBroadcast, `OCR error: ${e.message}`);
        }

        const codeMatch = ocrTextRaw?.match?.(/\b\d{3,6}\b/);
        const detectedCode = codeMatch ? codeMatch[0] : null;

        let reply = [];
        if (qrText) reply.push(`QR terdeteksi:\n${qrText}`);
        if (detectedCode) reply.push(`Kode terdeteksi: *${detectedCode}*`);
        if (ocrTextRaw) reply.push(`Teks OCR:\n${ocrTextRaw}`);

        const jam1 = (now.split(" ")[1] || "").slice(0, 5) || "??:??";
        if (qrText === "SEMINAR") {
            // cek peserta by nomor WA pengirim
            const peserta = await getParticipantByWa(fromNumber);

            if (!peserta) {
                await client.sendMessage(msg.from, "Anda tidak terdaftar sebagai peserta seminar ini");
                return;
            }

            // ❗️Guard: sudah presensi, tidak boleh masuk lagi
            if ((peserta.status_hadir || "").toLowerCase() === "yes") {
                const ts = (peserta.waktu_hadir && peserta.waktu_hadir !== "no")
                    ? peserta.waktu_hadir
                    : "waktu tidak tercatat";
                await client.sendMessage(
                    msg.from,
                    `Anda sudah melakukan presensi pada ${ts}. Masuk hanya diperbolehkan 1x.`
                );
                return;
            }

            // Belum presensi → cek pembayaran
            if ((peserta.status_bayar || "").toLowerCase() === "yes") {
                const now = formatAsiaJakartaDateTime();
                await setAttendanceYes(fromNumber, now); // set status_hadir=yes & waktu_hadir=now
                await client.sendMessage(msg.from, `✅ Selamat anda boleh masuk pada jam ${jam1}`);
            } else {
                await client.sendMessage(msg.from, "⛔ Anda belum melakukan pembayaran");
            }
            return;
        }

        if (qrText === "VOUCHERMAKAN") {
            const peserta = await getParticipantByWa(fromNumber);

            if (!peserta) {
                await client.sendMessage(msg.from, "⛔ Anda tidak terdaftar sebagai peserta seminar ini");
                return;
            }

            if ((peserta.status_voucher || "ready") === "ready") {
                await setVoucherStatus(fromNumber, "empty");
                await client.sendMessage(msg.from, `✅ Silahkan ambil makanan sekarang ${jam1}`);
            } else {
                // status_voucher == 'empty'
                await client.sendMessage(msg.from, "⛔ Anda tidak boleh mengambil makanan lagi");
            }
            return;
        }

        // (opsional) kalau QR bukan dua jenis di atas, kamu bisa kirim reply umum:
        if (reply.length === 0) {
            reply.push("Belum menemukan QR/teks yang jelas. Coba foto lebih dekat, terang, dan tidak blur ya 🙏");
        }
        await client.sendMessage(msg.from, reply.join("\n\n"));
        return;
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
                // ✅ kirim notifikasi ke peserta
                try {
                    const pesertaJid = `${pending.pesertaWa}@s.whatsapp.net`;
                    await client.sendMessage(
                        pesertaJid,
                        `Halo *${namaPeserta}*, pembayaran kamu sebesar *Rp.${formatRupiah(pending.nominal)}* telah *dikonfirmasi oleh admin*. Terima kasih! 🙏`
                    );
                } catch (e) {
                    wsBroadcast?.({ type: "log", message: `Notify peserta gagal: ${e.message}` });
                }
            } else {
                await client.sendMessage(msg.from, "Konfirmasi gagal: data tidak ditemukan/ sudah berubah.");
            }
            return;
        }
        if (text === "detil acara") {
            await client.sendMessage(msg.from, `Nama Acara : Seminar IT "The Power OF PERSONAL BRANDING"\nJadwal Pelaksanaan : Senin, 20 September 2025\nTempat : Ballroom Hotel Dafam\nJl. Uripsumoharjo No.122 Kota Pekalongan\n`);
        }
        if (text === "kirim gambar") {
            const media = MessageMedia.fromFilePath(INVITE_IMG);
            const caption = `Seminar IT "The Power Of "PERSONAL BRANDING"`;
            await client.sendMessage(msg.from, media, { caption });
        }
        // ===== PESERTA HADIR =====
        if (text === "peserta hadir") {
            const rows = await listHadirParticipants();
            const total = rows.length;

            if (total === 0) {
                await client.sendMessage(msg.from, "*Peserta Hadir*\nTotal: *0*\nBelum ada peserta yang hadir.");
                return;
            }

            // Tampilkan daftar nama (fallback ke nomor_wa jika nama null)
            const lines = rows.map((r, i) => {
                const nama = r.nama || r.nomor_wa;
                const ts = (r.waktu_hadir && r.waktu_hadir !== "no") ? ` — ${r.waktu_hadir}` : "";
                return `${i + 1}. ${nama}${ts}`;
            });
            // await client.sendMessage(
            //     msg.from,
            //     `*Peserta Hadir*\nTotal: *${total}*\n\n${lines.join("\n")}`
            // );
            // return;
            if (!(await isAdmin(fromNumber))) {
                await client.sendMessage(
                    msg.from,
                    `*Peserta Hadir*\nTotal: *${total}*`
                );
                return;
            } else {
                await client.sendMessage(
                    msg.from,
                    `*Peserta Hadir*\nTotal: *${total}*\n\n${lines.join("\n")}`
                );
                return;
            }
        }

        // ===== PESERTA SUDAH BAYAR =====
        if (text === "jumlah peserta sudah bayar") {
            if (!(await isAdmin(fromNumber))) {
                await client.sendMessage(msg.from, "anda bukan admin");
                return;
            }
            const paid = await countPaidParticipants();
            await client.sendMessage(
                msg.from,
                `*Peserta Sudah Bayar*\nTotal: *${paid}*`
            );
            return;
        }

        // ===== PESERTA BELUM BAYAR =====
        if (text === "jumlah peserta belum bayar") {
            if (!(await isAdmin(fromNumber))) {
                await client.sendMessage(msg.from, "anda bukan admin");
                return;
            }
            const unpaid = await countUnpaidParticipants();
            await client.sendMessage(
                msg.from,
                `*Peserta Belum Bayar*\nTotal: *${unpaid}*`
            );
            return;
        }
        // ===== PESERTA SUDAH BAYAR =====
        if (text === "peserta sudah bayar") {
            const rows = await listPaidParticipants();
            const total = rows.length;

            if (total === 0) {
                await client.sendMessage(msg.from, "*Peserta Sudah Bayar*\nTotal: *0*\nBelum ada peserta yang membayar.");
                return;
            }

            const lines = rows.map((r, i) => `${i + 1}. ${r.nama || r.nomor_wa}`);
            await client.sendMessage(
                msg.from,
                `*Peserta Sudah Bayar*\nTotal: *${total}*\n\n${lines.join("\n")}`
            );
            return;
        }

        // ===== PESERTA BELUM BAYAR =====
        if (text === "peserta belum bayar") {
            const rows = await listUnpaidParticipants();
            const total = rows.length;

            if (total === 0) {
                await client.sendMessage(msg.from, "*Peserta Belum Bayar*\nTotal: *0*\nSemua peserta sudah membayar 🎉");
                return;
            }

            const lines = rows.map((r, i) => `${i + 1}. ${r.nama || r.nomor_wa}`);
            await client.sendMessage(
                msg.from,
                `*Peserta Belum Bayar*\nTotal: *${total}*\n\n${lines.join("\n")}`
            );
            return;
        }



        // Jika non-admin mencoba pakai perintah "konfirmasi ..."
        if (/^konfirmasi\s+/i.test(text)) {
            await client.sendMessage(msg.from, "Anda tidak memiliki akses untuk konfirmasi.!");
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