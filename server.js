'use strict';
const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const fs        = require('fs');

// ── Config ───────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  console.warn('\n⚠️  JWT_SECRET not set — set it in production!\n');
  return 'omega-dev-secret-change-in-production';
})();
const SALT_ROUNDS = 10;
const USE_PG      = !!process.env.DATABASE_URL;   // true on Railway/Render

// ── PostgreSQL (production) ──────────────────────────────────────────
let pool = null;
if (USE_PG) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

async function initPG() {
  if (!USE_PG) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   TEXT   UNIQUE NOT NULL,
      hash       TEXT   NOT NULL,
      created_at TEXT   DEFAULT NOW()::TEXT
    );
    CREATE TABLE IF NOT EXISTS entries (
      user_id  INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entry_id TEXT NOT NULL,
      data     JSONB NOT NULL,
      PRIMARY KEY (user_id, entry_id)
    );
    CREATE TABLE IF NOT EXISTS settings (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data    JSONB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drafts (
      user_id INT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      data    JSONB NOT NULL DEFAULT '[]'
    );
  `);
  console.log('PostgreSQL tables ready.');
}

// ── JSON file storage (local dev) ────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!USE_PG) {
  ['users','entries','settings','drafts'].forEach(s => {
    const p = path.join(DATA_DIR, s);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  });
}

function readJSON(rel, def = null) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, rel), 'utf8')); }
  catch { return def; }
}
function writeJSON(rel, data) {
  const full = path.join(DATA_DIR, rel), tmp = full + '.tmp';
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, full);
}

// ── Storage API (works for both modes) ──────────────────────────────
async function dbFindUser(username) {
  if (USE_PG) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username.trim()]);
    return rows[0] || null;
  }
  const idx = readJSON('users/index.json', { _next: 1 });
  return idx[username.trim().toLowerCase()] || null;
}

async function dbCreateUser(username, hash) {
  if (USE_PG) {
    const { rows } = await pool.query(
      'INSERT INTO users (username, hash) VALUES ($1, $2) RETURNING id, username',
      [username.trim(), hash]);
    return rows[0];
  }
  const idx = readJSON('users/index.json', { _next: 1 });
  if (idx[username.trim().toLowerCase()]) return null; // duplicate
  const id = idx._next++;
  idx[username.trim().toLowerCase()] = { id, username: username.trim(), hash, createdAt: new Date().toISOString() };
  writeJSON('users/index.json', idx);
  return { id, username: username.trim() };
}

async function dbGetEntries(userId) {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT data FROM entries WHERE user_id = $1', [userId]);
    return rows.map(r => r.data);
  }
  return readJSON(`entries/${userId}.json`, []);
}

async function dbSaveEntries(userId, entries) {
  if (USE_PG) {
    await pool.query('DELETE FROM entries WHERE user_id = $1', [userId]);
    for (const e of entries) {
      await pool.query(
        'INSERT INTO entries (user_id, entry_id, data) VALUES ($1, $2, $3)',
        [userId, e.id, e]);
    }
  } else {
    writeJSON(`entries/${userId}.json`, entries);
  }
}

async function dbGetSettings(userId) {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT data FROM settings WHERE user_id = $1', [userId]);
    return rows[0]?.data || null;
  }
  return readJSON(`settings/${userId}.json`, null);
}

async function dbSaveSettings(userId, s) {
  if (USE_PG) {
    await pool.query(
      'INSERT INTO settings (user_id, data) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET data = $2',
      [userId, s]);
  } else {
    writeJSON(`settings/${userId}.json`, s);
  }
}

async function dbGetDrafts(userId) {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT data FROM drafts WHERE user_id = $1', [userId]);
    return rows[0]?.data || [];
  }
  return readJSON(`drafts/${userId}.json`, []);
}

async function dbSaveDrafts(userId, drafts) {
  if (USE_PG) {
    await pool.query(
      'INSERT INTO drafts (user_id, data) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET data = $2',
      [userId, JSON.stringify(drafts)]);
  } else {
    writeJSON(`drafts/${userId}.json`, drafts);
  }
}

// ── Express ──────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

const authLimit = rateLimit({ windowMs: 15*60*1000, max: 25,
  message: { error: 'Te veel pogingen. Probeer het over 15 minuten opnieuw.' } });

function requireAuth(req, res, next) {
  const hdr = req.headers.authorization;
  if (!hdr?.startsWith('Bearer ')) return res.status(401).json({ error: 'Niet ingelogd' });
  try { req.user = jwt.verify(hdr.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Sessie verlopen — log opnieuw in' }); }
}

function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
}

// ── POST /api/register ───────────────────────────────────────────────
app.post('/api/register', authLimit, async (req, res) => {
  try {
    const { username = '', password = '' } = req.body || {};
    const name = username.trim();
    if (!name || !password)           return res.status(400).json({ error: 'Gebruikersnaam en wachtwoord zijn verplicht' });
    if (name.length < 3)              return res.status(400).json({ error: 'Gebruikersnaam min. 3 tekens' });
    if (password.length < 6)          return res.status(400).json({ error: 'Wachtwoord min. 6 tekens' });
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) return res.status(400).json({ error: 'Gebruikersnaam: alleen letters, cijfers, punt, - en _' });

    const existing = await dbFindUser(name);
    if (existing) return res.status(409).json({ error: 'Gebruikersnaam al in gebruik' });

    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await dbCreateUser(name, hash);
    res.json({ token: signToken(user), username: user.username });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Serverfout' }); }
});

// ── POST /api/login ──────────────────────────────────────────────────
app.post('/api/login', authLimit, async (req, res) => {
  try {
    const { username = '', password = '' } = req.body || {};
    const user = await dbFindUser(username);
    const dummy = '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012346';
    const ok = user ? await bcrypt.compare(password, user.hash) : (await bcrypt.compare(password, dummy), false);
    if (!user || !ok) return res.status(401).json({ error: 'Ongeldige gebruikersnaam of wachtwoord' });
    res.json({ token: signToken(user), username: user.username });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Serverfout' }); }
});

// ── Data routes ──────────────────────────────────────────────────────
app.get('/api/entries', requireAuth, async (req, res) => {
  res.json(await dbGetEntries(req.user.id));
});

app.post('/api/entries', requireAuth, async (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'entries moet een array zijn' });
  await dbSaveEntries(req.user.id, entries);
  res.json({ ok: true });
});

app.get('/api/settings', requireAuth, async (req, res) => {
  res.json(await dbGetSettings(req.user.id));
});

app.put('/api/settings', requireAuth, async (req, res) => {
  await dbSaveSettings(req.user.id, req.body);
  res.json({ ok: true });
});

app.get('/api/export', requireAuth, async (req, res) => {
  const user = await dbFindUser(req.user.username);
  res.json({
    version: 2, exportedAt: new Date().toISOString(),
    username: user?.username ?? req.user.username,
    entries:  await dbGetEntries(req.user.id),
    settings: await dbGetSettings(req.user.id),
  });
});

app.post('/api/import', requireAuth, async (req, res) => {
  const { entries, settings } = req.body || {};
  if (!Array.isArray(entries)) return res.status(400).json({ error: 'Ongeldig backup bestand' });
  await dbSaveEntries(req.user.id, entries);
  if (settings && typeof settings === 'object') await dbSaveSettings(req.user.id, settings);
  res.json({ ok: true, count: entries.length });
});

app.get('/api/drafts', requireAuth, async (req, res) => {
  res.json(await dbGetDrafts(req.user.id));
});

app.post('/api/drafts', requireAuth, async (req, res) => {
  const { drafts } = req.body;
  if (!Array.isArray(drafts)) return res.status(400).json({ error: 'drafts moet een array zijn' });
  await dbSaveDrafts(req.user.id, drafts);
  res.json({ ok: true });
});

app.get('/api/health', (_, res) => res.json({ ok: true, mode: USE_PG ? 'postgres' : 'files' }));

// ── Start ─────────────────────────────────────────────────────────────
initPG().then(() => {
  app.listen(PORT, () =>
    console.log(`\n🚢  Omega Tracker → http://localhost:${PORT}  [${USE_PG ? 'PostgreSQL' : 'JSON files'}]\n`));
}).catch(err => { console.error('DB init failed:', err); process.exit(1); });
