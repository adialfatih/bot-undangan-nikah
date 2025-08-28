// src/db.js (ESM)
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
