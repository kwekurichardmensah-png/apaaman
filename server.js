'use strict';
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = Number(process.env.PORT) || 3000;
const storageRoot = process.env.APAAMAN_STORAGE_DIR || __dirname;
const UPLOAD_DIR = path.join(storageRoot, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const CATEGORIES = ['Crops & Food', 'Livestock', 'Tools & Equipment', 'Household', 'Services', 'Other'];
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const UPLOAD_RE = /^\/uploads\/[a-f0-9]{32}\.(jpg|png|webp|gif)$/;
const USER_COLS = 'u.id, u.phone, u.name, u.role, u.area, u.bio, u.avatar, u.created_at';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.disable('x-powered-by');
app.use((req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); next(); });
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '30d', immutable: true }));
app.use('/api', express.json({ limit: '100kb' }));

// ---------------------------------------------------------------- helpers
class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status) => { throw new UserError(message, status); };
const text = (v, max) => String(v ?? '').trim().slice(0, max);
const normPhone = (v) => String(v ?? '').replace(/[^\d+]/g, '').slice(0, 20);
const hashPin = (pin, salt) => crypto.scryptSync(pin, salt, 64).toString('hex');
const imageOrNull = (v) => {
  if (!v) return null;
  if (typeof v !== 'string' || !UPLOAD_RE.test(v)) fail('Invalid image.');
  return v;
};
const getUser = (id) => db.get(`SELECT ${USER_COLS} FROM users u WHERE u.id = ?`, id);

// Wraps a handler: return value is sent as JSON, thrown errors go to the error handler.
const handle = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (err) { next(err); }
};

function userByToken(token) {
  if (typeof token !== 'string' || !token) return null;
  return db.get(
    `SELECT ${USER_COLS} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, token);
}

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const user = header.startsWith('Bearer ') ? userByToken(header.slice(7)) : null;
  if (!user) return res.status(401).json({ error: 'Please log in again.' });
  req.user = user;
  next();
}

function startSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.run('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)', token, userId, Date.now());
  return { token, user: getUser(userId) };
}

// Simple protection against guessing PINs: 5 wrong tries locks the number for 5 minutes.
const attempts = new Map();
function checkLock(phone) {
  const a = attempts.get(phone);
  if (a && a.until > Date.now()) fail('Too many wrong PINs. Try again in a few minutes.', 429);
}
function recordFailure(phone) {
  const a = attempts.get(phone) || { count: 0, until: 0 };
  a.count += 1;
  if (a.count >= 5) { a.count = 0; a.until = Date.now() + 5 * 60 * 1000; }
  attempts.set(phone, a);
}

function isMember(conversationId, userId) {
  return !!db.get('SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ?', conversationId, userId);
}
function memberIds(conversationId) {
  return db.all('SELECT user_id FROM members WHERE conversation_id = ?', conversationId).map((r) => r.user_id);
}
const toRooms = (ids) => ids.map((id) => `user:${id}`);

// Shapes a conversation row for a particular user (direct chats show the other person).
function conversationFor(row, userId) {
  const members = db.all(
    `SELECT u.id, u.name, u.avatar, u.role FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.conversation_id = ?`, row.id);
  const out = {
    id: row.id,
    type: row.type,
    created_at: row.created_at,
    member_count: members.length,
    last_body: row.last_body ?? null,
    last_kind: row.last_kind ?? null,
    last_at: row.last_at ?? null,
    last_sender: row.last_sender ?? null,
    last_sender_name: row.last_sender_name ?? null,
    unread: row.unread ?? 0,
  };
  if (row.type === 'direct') {
    const other = members.find((m) => m.id !== userId) || members[0] || {};
    Object.assign(out, {
      title: other.name || 'Unknown', avatar: other.avatar || null, avatar_id: other.id,
      other_id: other.id, other_role: other.role || '',
    });
  } else {
    Object.assign(out, { title: row.name, avatar: null, avatar_id: row.id });
  }
  return out;
}

// ---------------------------------------------------------------- accounts
app.post('/api/register', handle((req) => {
  const phone = normPhone(req.body.phone);
  const name = text(req.body.name, 40);
  const pin = String(req.body.pin ?? '');
  if (!name) fail('Please enter your name.');
  if (phone.replace(/\D/g, '').length < 6) fail('Please enter a valid phone number.');
  if (!/^\d{4,6}$/.test(pin)) fail('Your PIN must be 4 to 6 digits.');
  if (db.get('SELECT id FROM users WHERE phone = ?', phone)) {
    fail('This phone number is already registered. Please log in instead.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const r = db.run(
    `INSERT INTO users (phone, name, pin_hash, salt, role, area, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    phone, name, hashPin(pin, salt), salt, text(req.body.role, 40), text(req.body.area, 40), Date.now());
  return startSession(Number(r.lastInsertRowid));
}));

app.post('/api/login', handle((req) => {
  const phone = normPhone(req.body.phone);
  const pin = String(req.body.pin ?? '');
  checkLock(phone);
  const row = db.get('SELECT id, pin_hash, salt FROM users WHERE phone = ?', phone);
  const ok = row && crypto.timingSafeEqual(Buffer.from(hashPin(pin, row.salt), 'hex'), Buffer.from(row.pin_hash, 'hex'));
  if (!ok) { recordFailure(phone); fail('Wrong phone number or PIN.'); }
  attempts.delete(phone);
  return startSession(row.id);
}));

app.post('/api/logout', auth, handle((req) => {
  db.run('DELETE FROM sessions WHERE token = ?', req.get('authorization').slice(7));
  return { ok: true };
}));

app.get('/api/me', auth, handle((req) => ({ user: req.user })));

app.put('/api/me', auth, handle((req) => {
  const name = text(req.body.name, 40);
  if (!name) fail('Please enter your name.');
  db.run('UPDATE users SET name = ?, role = ?, area = ?, bio = ?, avatar = ? WHERE id = ?',
    name, text(req.body.role, 40), text(req.body.area, 40), text(req.body.bio, 300),
    imageOrNull(req.body.avatar), req.user.id);
  return { user: getUser(req.user.id) };
}));

// ---------------------------------------------------------------- directory
app.get('/api/users', auth, handle((req) => {
  const q = `%${text(req.query.q, 60)}%`;
  return {
    users: db.all(
      `SELECT ${USER_COLS} FROM users u WHERE u.name LIKE ? OR u.role LIKE ? OR u.area LIKE ?
       ORDER BY u.name COLLATE NOCASE LIMIT 300`, q, q, q),
  };
}));

app.get('/api/users/:id', auth, handle((req) => {
  const user = getUser(Number(req.params.id));
  if (!user) fail('Person not found.', 404);
  const listings = db.all(
    `SELECT l.*, u.name AS seller_name, u.area AS seller_area FROM listings l JOIN users u ON u.id = l.user_id
     WHERE l.user_id = ? AND l.status = 'active' ORDER BY l.id DESC`, user.id);
  return { user, listings };
}));

// ---------------------------------------------------------------- chats
app.get('/api/conversations', auth, handle((req) => {
  const rows = db.all(
    `SELECT c.id, c.type, c.name, c.created_at,
            lm.body AS last_body, lm.kind AS last_kind, lm.created_at AS last_at,
            lm.sender_id AS last_sender, lu.name AS last_sender_name,
            (SELECT COUNT(*) FROM messages x
              WHERE x.conversation_id = c.id AND x.id > m.last_read_id AND x.sender_id <> m.user_id) AS unread
       FROM members m
       JOIN conversations c ON c.id = m.conversation_id
       LEFT JOIN messages lm ON lm.id = (SELECT MAX(id) FROM messages WHERE conversation_id = c.id)
       LEFT JOIN users lu ON lu.id = lm.sender_id
      WHERE m.user_id = ?
      ORDER BY COALESCE(lm.created_at, c.created_at) DESC`, req.user.id);
  return { conversations: rows.map((r) => conversationFor(r, req.user.id)) };
}));

app.post('/api/conversations/direct', auth, handle((req) => {
  const otherId = Number(req.body.userId);
  if (otherId === req.user.id) fail('You cannot start a chat with yourself.');
  if (!getUser(otherId)) fail('Person not found.', 404);
  let row = db.get(
    `SELECT c.* FROM conversations c
       JOIN members a ON a.conversation_id = c.id AND a.user_id = ?
       JOIN members b ON b.conversation_id = c.id AND b.user_id = ?
      WHERE c.type = 'direct'`, req.user.id, otherId);
  if (!row) {
    row = db.transaction(() => {
      const r = db.run(`INSERT INTO conversations (type, created_by, created_at) VALUES ('direct', ?, ?)`,
        req.user.id, Date.now());
      const id = Number(r.lastInsertRowid);
      db.run('INSERT INTO members (conversation_id, user_id) VALUES (?, ?), (?, ?)', id, req.user.id, id, otherId);
      return db.get('SELECT * FROM conversations WHERE id = ?', id);
    });
  }
  return { conversation: conversationFor(row, req.user.id) };
}));

app.post('/api/conversations/group', auth, handle((req) => {
  const name = text(req.body.name, 50);
  if (!name) fail('Please give the group a name.');
  const ids = [...new Set((Array.isArray(req.body.memberIds) ? req.body.memberIds : []).map(Number))]
    .filter((id) => id !== req.user.id && getUser(id));
  if (!ids.length) fail('Pick at least one person to add.');
  const row = db.transaction(() => {
    const r = db.run(`INSERT INTO conversations (type, name, created_by, created_at) VALUES ('group', ?, ?, ?)`,
      name, req.user.id, Date.now());
    const id = Number(r.lastInsertRowid);
    for (const uid of [req.user.id, ...ids]) {
      db.run('INSERT INTO members (conversation_id, user_id) VALUES (?, ?)', id, uid);
    }
    return db.get('SELECT * FROM conversations WHERE id = ?', id);
  });
  io.to(toRooms(ids)).emit('refresh');
  return { conversation: conversationFor(row, req.user.id) };
}));

app.get('/api/conversations/:id/messages', auth, handle((req) => {
  const id = Number(req.params.id);
  if (!isMember(id, req.user.id)) fail('Chat not found.', 404);
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const messages = db.all(
    `SELECT m.id, m.conversation_id, m.sender_id, u.name AS sender_name, m.kind, m.body, m.created_at
       FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT 50`, id, before).reverse();
  return { messages };
}));

app.post('/api/conversations/:id/messages', auth, handle((req) => {
  const id = Number(req.params.id);
  if (!isMember(id, req.user.id)) fail('Chat not found.', 404);
  const kind = req.body.kind === 'image' ? 'image' : 'text';
  const body = kind === 'image' ? imageOrNull(req.body.body) : text(req.body.body, 2000);
  if (!body) fail('Message is empty.');
  const r = db.run('INSERT INTO messages (conversation_id, sender_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)',
    id, req.user.id, kind, body, Date.now());
  const msgId = Number(r.lastInsertRowid);
  db.run('UPDATE members SET last_read_id = ? WHERE conversation_id = ? AND user_id = ?', msgId, id, req.user.id);
  const message = db.get(
    `SELECT m.id, m.conversation_id, m.sender_id, u.name AS sender_name, m.kind, m.body, m.created_at
       FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`, msgId);
  io.to(toRooms(memberIds(id))).emit('message', message);
  return { message };
}));

app.post('/api/conversations/:id/read', auth, handle((req) => {
  const id = Number(req.params.id);
  db.run('UPDATE members SET last_read_id = MAX(last_read_id, ?) WHERE conversation_id = ? AND user_id = ?',
    Number(req.body.lastId) || 0, id, req.user.id);
  return { ok: true };
}));

// ---------------------------------------------------------------- photos
app.post('/api/upload', auth,
  express.raw({ type: Object.keys(IMAGE_TYPES), limit: '8mb' }),
  handle((req) => {
    const ext = IMAGE_TYPES[req.get('content-type')];
    if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) fail('Please choose a photo (JPG, PNG, WEBP or GIF).');
    const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
    return { url: `/uploads/${name}` };
  }));

// ---------------------------------------------------------------- marketplace
const LISTING_SELECT = `SELECT l.*, u.name AS seller_name, u.area AS seller_area, u.phone AS seller_phone,
  u.avatar AS seller_avatar FROM listings l JOIN users u ON u.id = l.user_id`;

app.get('/api/listings', auth, handle((req) => {
  const where = [];
  const params = [];
  if (req.query.mine === '1') { where.push('l.user_id = ?'); params.push(req.user.id); }
  else where.push(`l.status = 'active'`);
  const q = text(req.query.q, 60);
  if (q) { where.push('(l.title LIKE ? OR l.description LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (CATEGORIES.includes(req.query.category)) { where.push('l.category = ?'); params.push(req.query.category); }
  return {
    listings: db.all(`${LISTING_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.id DESC LIMIT 200`, ...params),
  };
}));

app.get('/api/listings/:id', auth, handle((req) => {
  const listing = db.get(`${LISTING_SELECT} WHERE l.id = ?`, Number(req.params.id));
  if (!listing) fail('Listing not found.', 404);
  return { listing };
}));

app.post('/api/listings', auth, handle((req) => {
  const title = text(req.body.title, 80);
  if (!title) fail('Please say what you are selling.');
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : 'Other';
  const r = db.run(
    `INSERT INTO listings (user_id, title, description, price, category, image, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    req.user.id, title, text(req.body.description, 1000), text(req.body.price, 30), category,
    imageOrNull(req.body.image), Date.now());
  return { listing: db.get(`${LISTING_SELECT} WHERE l.id = ?`, Number(r.lastInsertRowid)) };
}));

function ownListing(req) {
  const listing = db.get('SELECT * FROM listings WHERE id = ?', Number(req.params.id));
  if (!listing) fail('Listing not found.', 404);
  if (listing.user_id !== req.user.id) fail('Only the seller can change this listing.', 403);
  return listing;
}

app.patch('/api/listings/:id', auth, handle((req) => {
  const listing = ownListing(req);
  const status = req.body.status === 'sold' ? 'sold' : 'active';
  db.run('UPDATE listings SET status = ? WHERE id = ?', status, listing.id);
  return { listing: db.get(`${LISTING_SELECT} WHERE l.id = ?`, listing.id) };
}));

app.delete('/api/listings/:id', auth, handle((req) => {
  const listing = ownListing(req);
  db.run('DELETE FROM listings WHERE id = ?', listing.id);
  return { ok: true };
}));

// ---------------------------------------------------------------- rides
const RIDE_SELECT = `SELECT r.*, u.name AS owner_name, u.phone AS owner_phone, u.area AS owner_area,
  u.avatar AS owner_avatar, a.name AS accepted_name, a.phone AS accepted_phone
  FROM rides r JOIN users u ON u.id = r.user_id
  LEFT JOIN users a ON a.id = r.accepted_by`;

app.get('/api/rides', auth, handle((req) => {
  const mine = req.query.mine === '1';
  const where = mine
    ? '(r.user_id = ? OR r.accepted_by = ?)'
    : '(r.status = ?)';
  const params = mine ? [req.user.id, req.user.id] : ['open'];
  return {
    rides: db.all(`${RIDE_SELECT} WHERE ${where} ORDER BY r.id DESC LIMIT 200`, ...params),
  };
}));

app.post('/api/rides', auth, handle((req) => {
  const pickup = text(req.body.pickup, 120);
  const destination = text(req.body.destination, 120);
  const kind = req.body.kind === 'offer' ? 'offer' : 'request';
  if (!pickup || !destination) fail('Please enter both pickup and destination.');
  const seats = Math.max(1, Math.min(8, Number(req.body.seats) || 1));
  const r = db.run(
    `INSERT INTO rides (user_id, kind, pickup, destination, ride_time, seats, fare, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    req.user.id, kind, pickup, destination, text(req.body.ride_time, 60), seats,
    text(req.body.fare, 30), text(req.body.notes, 500), Date.now());
  return { ride: db.get(`${RIDE_SELECT} WHERE r.id = ?`, Number(r.lastInsertRowid)) };
}));

app.get('/api/rides/:id', auth, handle((req) => {
  const ride = db.get(`${RIDE_SELECT} WHERE r.id = ?`, Number(req.params.id));
  if (!ride) fail('Ride not found.', 404);
  return { ride };
}));

app.patch('/api/rides/:id', auth, handle((req) => {
  const ride = db.get('SELECT * FROM rides WHERE id = ?', Number(req.params.id));
  if (!ride) fail('Ride not found.', 404);
  if (req.body.action === 'accept') {
    if (ride.user_id === req.user.id) fail('You cannot accept your own ride.');
    if (ride.status !== 'open') fail('This ride is no longer available.');
    db.run('UPDATE rides SET accepted_by = ?, status = ? WHERE id = ?', req.user.id, 'accepted', ride.id);
  } else if (req.body.action === 'complete') {
    if (ride.user_id !== req.user.id && ride.accepted_by !== req.user.id) fail('Only ride members can complete it.', 403);
    db.run('UPDATE rides SET status = ? WHERE id = ?', 'completed', ride.id);
  } else if (req.body.action === 'cancel') {
    if (ride.user_id !== req.user.id && ride.accepted_by !== req.user.id) fail('Only ride members can cancel it.', 403);
    db.run('UPDATE rides SET status = ? WHERE id = ?', 'cancelled', ride.id);
  } else {
    fail('Unknown ride action.');
  }
  return { ride: db.get(`${RIDE_SELECT} WHERE r.id = ?`, ride.id) };
}));

// ---------------------------------------------------------------- errors
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too big.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

// ---------------------------------------------------------------- realtime
io.use((socket, next) => {
  const user = userByToken(socket.handshake.auth?.token);
  if (!user) return next(new Error('unauthorized'));
  socket.user = user;
  next();
});
io.on('connection', (socket) => socket.join(`user:${socket.user.id}`));

// ---------------------------------------------------------------- start
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  Apaaman is running!\n');
  console.log(`  On this computer:        http://localhost:${PORT}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  On phones (same Wi-Fi):  http://${a.address}:${PORT}`);
    }
  }
  console.log('\n  Press Ctrl+C to stop.\n');
});
