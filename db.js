'use strict';
// SQLite database using Node's built-in driver (no extra installs needed).
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const dir = path.join(__dirname, 'data');
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
`);

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
