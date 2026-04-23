require('dotenv').config();
const express      = require('express');
const { Pool }     = require('pg');
const bcrypt       = require('bcryptjs');
const { v4: uuid } = require('uuid');
const cookieParser = require('cookie-parser');
const compression  = require('compression');
const path         = require('path');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL not set. Link PostgreSQL plugin in Railway → Variables.');
  process.exit(1);
}

const app  = express();
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  max: 10,
});
pool.on('error', err => console.error('Pool error:', err.message));

app.use(compression());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB INIT with retry ──
async function initDB(retries = 8, delay = 3000) {
  const fs     = require('fs');
  const schema = fs.readFileSync(path.join(__dirname, 'db/schema.sql'), 'utf8');
  for (let i = 1; i <= retries; i++) {
    try { await pool.query(schema); console.log('✅ DB ready'); return; }
    catch (e) {
      console.error(`DB attempt ${i}/${retries}: ${e.message}`);
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ── AUTH ──
async function auth(req, res, next) {
  const token = req.cookies.session || req.headers['x-session'];
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { rows } = await pool.query(
      `SELECT s.member_id, m.name, m.is_admin, m.is_active
       FROM sessions s JOIN members m ON m.id = s.member_id
       WHERE s.id=$1 AND s.expires_at>NOW()`, [token]);
    if (!rows.length || !rows[0].is_active) return res.status(401).json({ error: 'Session expired' });
    req.user = rows[0];
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}
const adminOnly = (req, res, next) => req.user.is_admin ? next() : res.status(403).json({ error: 'Admin only' });

// ── SETUP ──
app.get('/api/setup/status', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM members WHERE is_admin=TRUE LIMIT 1');
    res.json({ setupDone: rows.length > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/setup', async (req, res) => {
  try {
    const { adminName, adminPin } = req.body;
    if (!adminName || !adminPin) return res.status(400).json({ error: 'Name and PIN required' });
    const { rows } = await pool.query('SELECT id FROM members WHERE is_admin=TRUE LIMIT 1');
    if (rows.length) return res.status(400).json({ error: 'Admin already exists' });
    const hash = await bcrypt.hash(String(adminPin), 10);
    await pool.query('INSERT INTO members (name,pin,is_admin) VALUES ($1,$2,TRUE)', [adminName, hash]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AUTH ROUTES ──
app.post('/api/login', async (req, res) => {
  try {
    const { name, pin } = req.body;
    const { rows } = await pool.query(
      'SELECT * FROM members WHERE LOWER(name)=LOWER($1) AND is_active=TRUE', [name.trim()]);
    if (!rows.length) return res.status(401).json({ error: 'Member not found' });
    if (!await bcrypt.compare(String(pin), rows[0].pin)) return res.status(401).json({ error: 'Wrong PIN' });
    const token = uuid();
    await pool.query('INSERT INTO sessions (id,member_id) VALUES ($1,$2)', [token, rows[0].id]);
    await pool.query('DELETE FROM sessions WHERE expires_at<NOW()');
    res.cookie('session', token, { httpOnly: true, sameSite: 'lax', maxAge: 12*60*60*1000 });
    res.json({ ok: true, name: rows[0].name, isAdmin: rows[0].is_admin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', async (req, res) => {
  const token = req.cookies.session;
  if (token) await pool.query('DELETE FROM sessions WHERE id=$1', [token]);
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) =>
  res.json({ name: req.user.name, isAdmin: req.user.is_admin, memberId: req.user.member_id }));

// ── ITEMS ──
app.get('/api/items', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM items WHERE is_active=TRUE ORDER BY display_order,id');
  res.json(rows);
});
app.post('/api/items', auth, adminOnly, async (req, res) => {
  try {
    const { name, rate } = req.body;
    const { rows } = await pool.query('INSERT INTO items (name,rate) VALUES ($1,$2) RETURNING *', [name, rate]);
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/items/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, rate, is_active } = req.body;
    const { rows } = await pool.query(
      'UPDATE items SET name=$1,rate=$2,is_active=$3 WHERE id=$4 RETURNING *',
      [name, rate, is_active ?? true, req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/items/:id', auth, adminOnly, async (req, res) => {
  await pool.query('UPDATE items SET is_active=FALSE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── MEMBERS ──
app.get('/api/members', auth, adminOnly, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id,name,is_admin,is_active,created_at FROM members ORDER BY is_admin DESC,name');
  res.json(rows);
});
app.post('/api/members', auth, adminOnly, async (req, res) => {
  try {
    const { name, pin } = req.body;
    if (!name || !pin) return res.status(400).json({ error: 'Name and PIN required' });
    const hash = await bcrypt.hash(String(pin), 10);
    const { rows } = await pool.query(
      'INSERT INTO members (name,pin) VALUES ($1,$2) RETURNING id,name,is_admin,is_active,created_at',
      [name.trim(), hash]);
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: 'Member already exists' }); }
});
app.put('/api/members/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, pin, is_active } = req.body;
    let q, p;
    if (pin) {
      const hash = await bcrypt.hash(String(pin), 10);
      q = 'UPDATE members SET name=$1,pin=$2,is_active=$3 WHERE id=$4 RETURNING id,name,is_admin,is_active';
      p = [name, hash, is_active ?? true, req.params.id];
    } else {
      q = 'UPDATE members SET name=$1,is_active=$2 WHERE id=$3 RETURNING id,name,is_admin,is_active';
      p = [name, is_active ?? true, req.params.id];
    }
    const { rows } = await pool.query(q, p);
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/members/:id', auth, adminOnly, async (req, res) => {
  await pool.query('UPDATE members SET is_active=FALSE WHERE id=$1 AND is_admin=FALSE', [req.params.id]);
  res.json({ ok: true });
});

// ── SESSION (daily) ──
// Get or create today's session
async function getOrCreateSession(date) {
  const d = date || new Date().toISOString().split('T')[0];
  const { rows } = await pool.query('SELECT * FROM daily_sessions WHERE date=$1', [d]);
  if (rows.length) return rows[0];
  const { rows: nr } = await pool.query(
    'INSERT INTO daily_sessions (date) VALUES ($1) ON CONFLICT (date) DO UPDATE SET date=EXCLUDED.date RETURNING *', [d]);
  return nr[0];
}

app.get('/api/session/today', auth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const sess = await getOrCreateSession(date);
    res.json(sess);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TAB ENTRIES ──

// Member adds item(s) — can call multiple times
app.post('/api/tab', auth, async (req, res) => {
  try {
    const date  = req.body.date || new Date().toISOString().split('T')[0];
    const sess  = await getOrCreateSession(date);
    if (sess.status === 'paid') return res.status(400).json({ error: 'Session already paid and closed' });

    const entries = req.body.entries; // [{ item_id, qty }]
    if (!entries || !entries.length) return res.status(400).json({ error: 'No items provided' });

    const inserted = [];
    for (const e of entries) {
      if (!e.qty || e.qty <= 0) continue;
      const { rows: item } = await pool.query('SELECT * FROM items WHERE id=$1 AND is_active=TRUE', [e.item_id]);
      if (!item.length) continue;
      const { rows } = await pool.query(
        `INSERT INTO tab_entries (session_id,member_id,item_id,item_name,rate,qty)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [sess.id, req.user.member_id, e.item_id, item[0].name, item[0].rate, e.qty]);
      inserted.push(rows[0]);
    }
    res.json({ ok: true, entries: inserted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Delete a specific tab entry (member can undo last add)
app.delete('/api/tab/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT te.*, ds.status FROM tab_entries te JOIN daily_sessions ds ON ds.id=te.session_id WHERE te.id=$1',
      [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].status === 'paid') return res.status(400).json({ error: 'Session already paid' });
    if (!req.user.is_admin && rows[0].member_id !== req.user.member_id)
      return res.status(403).json({ error: 'Not your entry' });
    await pool.query('DELETE FROM tab_entries WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Member: get my tab for a date
app.get('/api/tab/mine', auth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const sess = await getOrCreateSession(date);
    const { rows } = await pool.query(
      `SELECT te.* FROM tab_entries te WHERE te.session_id=$1 AND te.member_id=$2 ORDER BY te.added_at`,
      [sess.id, req.user.member_id]);
    const total = rows.reduce((s, r) => s + parseFloat(r.amount), 0);
    res.json({ session: sess, entries: rows, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: get full tab for a date (all members)
app.get('/api/tab/all', auth, adminOnly, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const sess = await getOrCreateSession(date);

    const { rows: entries } = await pool.query(
      `SELECT te.*, m.name as member_name
       FROM tab_entries te
       JOIN members m ON m.id=te.member_id
       WHERE te.session_id=$1
       ORDER BY m.name, te.added_at`, [sess.id]);

    // Group by member
    const byMember = {};
    for (const e of entries) {
      if (!byMember[e.member_name]) byMember[e.member_name] = { entries: [], total: 0, member_id: e.member_id };
      byMember[e.member_name].entries.push(e);
      byMember[e.member_name].total += parseFloat(e.amount);
    }

    // Item summary (for coffee shop bill)
    const itemSummary = {};
    for (const e of entries) {
      if (!itemSummary[e.item_name]) itemSummary[e.item_name] = { qty: 0, amount: 0, rate: e.rate };
      itemSummary[e.item_name].qty    += e.qty;
      itemSummary[e.item_name].amount += parseFloat(e.amount);
    }

    const grandTotal = entries.reduce((s, e) => s + parseFloat(e.amount), 0);
    res.json({ session: sess, byMember, itemSummary, grandTotal, entryCount: entries.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: mark session as paid
app.post('/api/tab/pay', auth, adminOnly, async (req, res) => {
  try {
    const date = req.body.date || new Date().toISOString().split('T')[0];
    const { rows } = await pool.query(
      `UPDATE daily_sessions SET status='paid', paid_at=NOW(), paid_by=$1 WHERE date=$2 RETURNING *`,
      [req.user.member_id, date]);
    if (!rows.length) return res.status(404).json({ error: 'No session for this date' });
    res.json({ ok: true, session: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: reopen a paid session
app.post('/api/tab/reopen', auth, adminOnly, async (req, res) => {
  try {
    const date = req.body.date || new Date().toISOString().split('T')[0];
    await pool.query(`UPDATE daily_sessions SET status='open', paid_at=NULL, paid_by=NULL WHERE date=$1`, [date]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: history of past sessions
app.get('/api/sessions', auth, adminOnly, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ds.*, COALESCE(SUM(te.amount),0) as total, COUNT(DISTINCT te.member_id) as member_count
       FROM daily_sessions ds LEFT JOIN tab_entries te ON te.session_id=ds.id
       GROUP BY ds.id ORDER BY ds.date DESC LIMIT 30`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── CATCH-ALL ──
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// ── START ──
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`☕ Morning Accounts on port ${PORT}`)))
  .catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
