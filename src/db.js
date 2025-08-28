// src/db.js (ESM)
import "dotenv/config";
import mysql from "mysql2/promise";

export const pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASS || "",
    database: process.env.DB_NAME || "wa_bot",
    port: Number(process.env.DB_PORT || 3306),
    waitForConnections: true,
    connectionLimit: 10,
    timezone: "Z" // simpan UTC; kita format manual ke Asia/Jakarta saat insert
});

// Inisialisasi tabel bila belum ada
export async function initSchema() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS table_user (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        nomor_wa VARCHAR(32) NOT NULL UNIQUE,
        nama VARCHAR(100) NULL,
        created_at DATETIME NOT NULL,
        PRIMARY KEY (id),
        KEY (nomor_wa)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS table_peserta (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        nomor_wa VARCHAR(32) NOT NULL UNIQUE,
        nominal_pembayaran INT NOT NULL,
        status_bayar VARCHAR(10) NOT NULL DEFAULT 'no',
        status_hadir VARCHAR(10) NOT NULL DEFAULT 'no',
        status_voucher VARCHAR(20) NOT NULL DEFAULT 'ready',
        waktu_hadir VARCHAR(32) NOT NULL DEFAULT 'no',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
    // ⬇️ NEW: table_admin
    await pool.query(`
        CREATE TABLE IF NOT EXISTS table_admin (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        nomor_wa_admin VARCHAR(32) NOT NULL UNIQUE,
        PRIMARY KEY (id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
}


// Helper CRUD
export async function getUserByWa(nomorWa) {
    const [rows] = await pool.query(
        "SELECT id, nomor_wa, nama, created_at FROM table_user WHERE nomor_wa = ? LIMIT 1",
        [nomorWa]
    );
    return rows[0] || null;
}

export async function createUser({ nomor_wa, nama, created_at }) {
    await pool.query(
        "INSERT INTO table_user (nomor_wa, nama, created_at) VALUES (?, ?, ?)",
        [nomor_wa, nama, created_at]
    );
}
// ⬇️ TAMBAHKAN: helper simpan/UPSERT peserta
export async function createParticipant({
    nomor_wa,
    nominal_pembayaran,
    status_bayar = "no",
    status_hadir = "no",
    status_voucher = "ready",
    waktu_hadir = "no"
}) {
    const [res] = await pool.query(
        `INSERT INTO table_peserta
      (nomor_wa, nominal_pembayaran, status_bayar, status_hadir, status_voucher, waktu_hadir)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       nominal_pembayaran = VALUES(nominal_pembayaran)`,
        [nomor_wa, nominal_pembayaran, status_bayar, status_hadir, status_voucher, waktu_hadir]
    );
    return res;
}

// ⬇️ NEW: cek admin
export async function isAdmin(nomorWa) {
    const [rows] = await pool.query(
        "SELECT id FROM table_admin WHERE nomor_wa_admin = ? LIMIT 1",
        [nomorWa]
    );
    return !!rows[0];
}

// ⬇️ NEW: ambil peserta by nominal unik
export async function getParticipantByNominal(nominal) {
    const [rows] = await pool.query(
        "SELECT id, nomor_wa, nominal_pembayaran, status_bayar FROM table_peserta WHERE nominal_pembayaran = ? LIMIT 1",
        [nominal]
    );
    return rows[0] || null;
}

// ⬇️ NEW: set status_bayar = 'yes' by nominal
export async function setPaidByNominal(nominal) {
    const [res] = await pool.query(
        "UPDATE table_peserta SET status_bayar = 'yes' WHERE nominal_pembayaran = ? LIMIT 1",
        [nominal]
    );
    return res.affectedRows;
}

export async function getParticipantByWa(nomorWa) {
    const [rows] = await pool.query(
        "SELECT id, nomor_wa, nominal_pembayaran, status_bayar, status_hadir, status_voucher, waktu_hadir FROM table_peserta WHERE nomor_wa = ? LIMIT 1",
        [nomorWa]
    );
    return rows[0] || null;
}

// Statistik peserta
export async function countParticipants() {
    const [rows] = await pool.query("SELECT COUNT(*) AS total FROM table_peserta");
    return rows[0]?.total || 0;
}

export async function countPaidParticipants() {
    const [rows] = await pool.query("SELECT COUNT(*) AS total FROM table_peserta WHERE status_bayar = 'yes'");
    return rows[0]?.total || 0;
}