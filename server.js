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
    CREATE TABLE IF NOT EXISTS posts (
      id         SERIAL PRIMARY KEY,
      user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username   TEXT NOT NULL,
      content    TEXT NOT NULL,
      image      TEXT,
      likes      JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS group_messages (
      id         SERIAL PRIMARY KEY,
      user_id    INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username   TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS direct_messages (
      id             SERIAL PRIMARY KEY,
      from_user_id   INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_username  TEXT NOT NULL,
      to_user_id     INT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_username    TEXT NOT NULL,
      content        TEXT NOT NULL,
      read           BOOLEAN NOT NULL DEFAULT FALSE,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('PostgreSQL tables ready.');
}

// ── JSON file storage (local dev) ────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!USE_PG) {
  ['users','entries','settings','drafts','social'].forEach(s => {
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

async function dbGetUserById(userId) {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT id, username FROM users WHERE id = $1', [userId]);
    return rows[0] || null;
  }
  const idx = readJSON('users/index.json', { _next: 1 });
  const u = Object.values(idx).find(v => v && v.id == userId);
  return u ? { id: u.id, username: u.username } : null;
}

async function dbGetAllUsers() {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT id, username FROM users ORDER BY username ASC');
    return rows;
  }
  const idx = readJSON('users/index.json', { _next: 1 });
  return Object.values(idx).filter(v => v && v.id)
    .map(v => ({ id: v.id, username: v.username }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

// ── Feed ────────────────────────────────────────────────────────────
async function dbGetFeed(offset = 0, limit = 20) {
  if (USE_PG) {
    const { rows } = await pool.query(
      'SELECT id, user_id, username, content, image, likes, created_at FROM posts ORDER BY created_at DESC LIMIT $1 OFFSET $2',
      [limit, offset]);
    return rows;
  }
  const all = readJSON('social/posts.json', []);
  return all.slice().reverse().slice(offset, offset + limit);
}

async function dbCreatePost(userId, username, content, image) {
  if (USE_PG) {
    const { rows } = await pool.query(
      "INSERT INTO posts (user_id, username, content, image, likes) VALUES ($1,$2,$3,$4,'[]') RETURNING *",
      [userId, username, content, image || null]);
    return rows[0];
  }
  const posts = readJSON('social/posts.json', []);
  const post = { id: Date.now(), user_id: userId, username, content, image: image || null, likes: [], created_at: new Date().toISOString() };
  posts.push(post);
  writeJSON('social/posts.json', posts);
  return post;
}

async function dbDeletePost(postId, userId) {
  if (USE_PG) {
    await pool.query('DELETE FROM posts WHERE id = $1 AND user_id = $2', [postId, userId]);
  } else {
    const posts = readJSON('social/posts.json', []);
    writeJSON('social/posts.json', posts.filter(p => !(p.id == postId && p.user_id == userId)));
  }
}

async function dbToggleLike(postId, userId) {
  if (USE_PG) {
    const { rows } = await pool.query('SELECT likes FROM posts WHERE id = $1', [postId]);
    if (!rows[0]) return null;
    let likes = rows[0].likes || [];
    likes = likes.includes(userId) ? likes.filter(id => id !== userId) : [...likes, userId];
    await pool.query('UPDATE posts SET likes = $1 WHERE id = $2', [JSON.stringify(likes), postId]);
    return likes;
  }
  const posts = readJSON('social/posts.json', []);
  const post = posts.find(p => p.id == postId);
  if (!post) return null;
  if (post.likes.includes(userId)) post.likes = post.likes.filter(id => id !== userId);
  else post.likes.push(userId);
  writeJSON('social/posts.json', posts);
  return post.likes;
}

// ── Group chat ──────────────────────────────────────────────────────
async function dbGetGroupMessages(after = 0) {
  if (USE_PG) {
    const { rows } = await pool.query(
      'SELECT id, user_id, username, content, created_at FROM group_messages WHERE id > $1 ORDER BY id ASC LIMIT 200',
      [after]);
    return rows;
  }
  return readJSON('social/group.json', []).filter(m => m.id > after);
}

async function dbPostGroupMessage(userId, username, content) {
  if (USE_PG) {
    const { rows } = await pool.query(
      'INSERT INTO group_messages (user_id, username, content) VALUES ($1,$2,$3) RETURNING *',
      [userId, username, content]);
    return rows[0];
  }
  const msgs = readJSON('social/group.json', []);
  const msg = { id: Date.now(), user_id: userId, username, content, created_at: new Date().toISOString() };
  msgs.push(msg);
  writeJSON('social/group.json', msgs);
  return msg;
}

// ── Direct messages ─────────────────────────────────────────────────
async function dbGetDirectMessages(userId, otherId, after = 0) {
  if (USE_PG) {
    const { rows } = await pool.query(
      `SELECT id,from_user_id,from_username,to_user_id,to_username,content,read,created_at
       FROM direct_messages
       WHERE ((from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1)) AND id>$3
       ORDER BY id ASC LIMIT 200`,
      [userId, otherId, after]);
    return rows;
  }
  return readJSON('social/dm.json', []).filter(m =>
    ((m.from_user_id == userId && m.to_user_id == otherId) ||
     (m.from_user_id == otherId && m.to_user_id == userId)) && m.id > after);
}

async function dbPostDirectMessage(fromId, fromUsername, toId, toUsername, content) {
  if (USE_PG) {
    const { rows } = await pool.query(
      'INSERT INTO direct_messages (from_user_id,from_username,to_user_id,to_username,content) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [fromId, fromUsername, toId, toUsername, content]);
    return rows[0];
  }
  const msgs = readJSON('social/dm.json', []);
  const msg = { id: Date.now(), from_user_id: fromId, from_username: fromUsername, to_user_id: toId, to_username: toUsername, content, read: false, created_at: new Date().toISOString() };
  msgs.push(msg);
  writeJSON('social/dm.json', msgs);
  return msg;
}

async function dbMarkDMsRead(toUserId, fromUserId) {
  if (USE_PG) {
    await pool.query(
      'UPDATE direct_messages SET read=TRUE WHERE to_user_id=$1 AND from_user_id=$2 AND read=FALSE',
      [toUserId, fromUserId]);
  } else {
    const msgs = readJSON('social/dm.json', []);
    msgs.forEach(m => { if (m.to_user_id == toUserId && m.from_user_id == fromUserId) m.read = true; });
    writeJSON('social/dm.json', msgs);
  }
}

async function dbGetUnreadCounts(userId) {
  if (USE_PG) {
    const { rows } = await pool.query(
      `SELECT from_user_id, from_username, COUNT(*) AS count
       FROM direct_messages WHERE to_user_id=$1 AND read=FALSE
       GROUP BY from_user_id, from_username`,
      [userId]);
    return rows.map(r => ({ from_user_id: r.from_user_id, from_username: r.from_username, count: parseInt(r.count) }));
  }
  const msgs = readJSON('social/dm.json', []);
  const map = {};
  msgs.filter(m => m.to_user_id == userId && !m.read).forEach(m => {
    if (!map[m.from_user_id]) map[m.from_user_id] = { from_user_id: m.from_user_id, from_username: m.from_username, count: 0 };
    map[m.from_user_id].count++;
  });
  return Object.values(map);
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

// ── Users list ───────────────────────────────────────────────────────
app.get('/api/users', requireAuth, async (req, res) => {
  const all = await dbGetAllUsers();
  res.json(all.filter(u => u.id !== req.user.id));
});

// ── Feed ─────────────────────────────────────────────────────────────
app.get('/api/feed', requireAuth, async (req, res) => {
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const limit  = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  res.json(await dbGetFeed(offset, limit));
});

app.post('/api/feed', requireAuth, async (req, res) => {
  const { content = '', image } = req.body || {};
  if (!content.trim()) return res.status(400).json({ error: 'Inhoud is verplicht' });
  if (image && image.length > 2 * 1024 * 1024) return res.status(413).json({ error: 'Afbeelding te groot (max 1.5 MB)' });
  const post = await dbCreatePost(req.user.id, req.user.username, content.trim(), image || null);
  res.json(post);
});

app.delete('/api/feed/:id', requireAuth, async (req, res) => {
  await dbDeletePost(req.params.id, req.user.id);
  res.json({ ok: true });
});

app.post('/api/feed/:id/like', requireAuth, async (req, res) => {
  const likes = await dbToggleLike(req.params.id, req.user.id);
  if (likes === null) return res.status(404).json({ error: 'Post niet gevonden' });
  res.json({ likes });
});

// ── Group chat ───────────────────────────────────────────────────────
app.get('/api/chat/group', requireAuth, async (req, res) => {
  const after = Math.max(0, parseInt(req.query.after) || 0);
  res.json(await dbGetGroupMessages(after));
});

app.post('/api/chat/group', requireAuth, async (req, res) => {
  const { content = '' } = req.body || {};
  if (!content.trim()) return res.status(400).json({ error: 'Bericht is verplicht' });
  res.json(await dbPostGroupMessage(req.user.id, req.user.username, content.trim()));
});

// ── Direct messages ──────────────────────────────────────────────────
app.get('/api/chat/unread', requireAuth, async (req, res) => {
  res.json(await dbGetUnreadCounts(req.user.id));
});

app.get('/api/chat/dm/:userId', requireAuth, async (req, res) => {
  const other = parseInt(req.params.userId);
  const after = Math.max(0, parseInt(req.query.after) || 0);
  const msgs  = await dbGetDirectMessages(req.user.id, other, after);
  await dbMarkDMsRead(req.user.id, other);
  res.json(msgs);
});

app.post('/api/chat/dm/:userId', requireAuth, async (req, res) => {
  const { content = '' } = req.body || {};
  if (!content.trim()) return res.status(400).json({ error: 'Bericht is verplicht' });
  const toUser = await dbGetUserById(parseInt(req.params.userId));
  if (!toUser) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
  res.json(await dbPostDirectMessage(req.user.id, req.user.username, toUser.id, toUser.username, content.trim()));
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
