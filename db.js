'use strict';
// SQLite database using Node's built-in driver (no extra installs needed).
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const storageRoot = process.env.APAAMAN_STORAGE_DIR || __dirname;
const dir = path.join(storageRoot, 'data');
fs.mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(path.join(dir, 'apaaman.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    phone      TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    pin_hash   TEXT NOT NULL,
    salt       TEXT NOT NULL,
    role       TEXT NOT NULL DEFAULT '',
    area       TEXT NOT NULL DEFAULT '',
    bio        TEXT NOT NULL DEFAULT '',
    avatar     TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    type       TEXT NOT NULL CHECK (type IN ('direct', 'group')),
    name       TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS members (
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_id    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);

  CREATE TABLE IF NOT EXISTS messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       INTEGER NOT NULL REFERENCES users(id),
    kind            TEXT NOT NULL CHECK (kind IN ('text', 'image')),
    body            TEXT NOT NULL,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

  CREATE TABLE IF NOT EXISTS listings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price       TEXT NOT NULL DEFAULT '',
    category    TEXT NOT NULL,
    image       TEXT,
    status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold')),
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, id);

  CREATE TABLE IF NOT EXISTS rides (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    accepted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('request', 'offer')),
    pickup      TEXT NOT NULL,
    destination TEXT NOT NULL,
    ride_time   TEXT NOT NULL DEFAULT '',
    seats       INTEGER NOT NULL DEFAULT 1,
    fare        TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'completed', 'cancelled')),
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status, id);
`);

const adminPhone = process.env.APAAMAN_ADMIN_PHONE?.trim();
const adminPin = process.env.APAAMAN_ADMIN_PIN;
if (adminPhone || adminPin) {
  if (!adminPhone || !/^\d{4,6}$/.test(adminPin || '')) {
    throw new Error('Set both APAAMAN_ADMIN_PHONE and a 4–6 digit APAAMAN_ADMIN_PIN to bootstrap an admin.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const pinHash = crypto.scryptSync(adminPin, salt, 64).toString('hex');
  const existingAdmin = db.prepare('SELECT id FROM users WHERE phone = ?').get(adminPhone);
  if (!existingAdmin) {
    db.prepare(
      `INSERT INTO users (phone, name, pin_hash, salt, role, area, bio, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(adminPhone, 'Administrator', pinHash, salt, 'admin', 'Administration', 'Community administrator', Date.now());
  } else {
    db.prepare(
      `UPDATE users SET name = ?, pin_hash = ?, salt = ?, role = ? WHERE phone = ?`,
    ).run('Administrator', pinHash, salt, 'admin', adminPhone);
  }
}

module.exports = {
  get: (sql, ...params) => db.prepare(sql).get(...params),
  all: (sql, ...params) => db.prepare(sql).all(...params),
  run: (sql, ...params) => db.prepare(sql).run(...params),
  transaction(fn) {
    db.exec('BEGIN');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },
};
