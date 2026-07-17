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
    res.json({ ok: true, name: rows[0].name, isAdmin: rows[0].is_admin, memberId: rows[0].id });
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

// Compute grand total, amount paid so far, and pending balance for a session
async function getSessionMoney(sessionId) {
  const { rows: t } = await pool.query(
    'SELECT COALESCE(SUM(amount),0) as total FROM tab_entries WHERE session_id=$1', [sessionId]);
  const { rows: p } = await pool.query(
    'SELECT COALESCE(SUM(amount),0) as paid FROM session_payments WHERE session_id=$1', [sessionId]);
  const grandTotal = parseFloat(t[0].total);
  const amountPaid = parseFloat(p[0].paid);
  const pending    = Math.max(0, Math.round((grandTotal - amountPaid) * 100) / 100);
  return { grandTotal, amountPaid, pending };
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
    if (sess.status !== 'open') return res.status(400).json({ error: 'Session is locked — payment already started. Ask admin to reopen it.' });

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
    if (rows[0].status !== 'open') return res.status(400).json({ error: 'Session is locked — payment already started' });
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

// Everyone: get full tab for a date (all members) — needed so anyone can view & pay the bill
app.get('/api/tab/all', auth, async (req, res) => {
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

    const { rows: payments } = await pool.query(
      `SELECT sp.*, m.name as paid_by_name
       FROM session_payments sp LEFT JOIN members m ON m.id = sp.paid_by
       WHERE sp.session_id=$1 ORDER BY sp.paid_at`, [sess.id]);
    const amountPaid = payments.reduce((s, p) => s + parseFloat(p.amount), 0);
    const pending    = Math.max(0, Math.round((grandTotal - amountPaid) * 100) / 100);

    res.json({ session: sess, byMember, itemSummary, grandTotal, entryCount: entries.length, payments, amountPaid, pending });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Any member: record a payment against a session (full or partial)
app.post('/api/tab/pay', auth, async (req, res) => {
  try {
    const date = req.body.date || new Date().toISOString().split('T')[0];
    const sess = await getOrCreateSession(date);
    if (sess.status === 'paid') return res.status(400).json({ error: 'Session already fully paid' });

    const { grandTotal, pending } = await getSessionMoney(sess.id);
    if (grandTotal <= 0) return res.status(400).json({ error: 'Nothing to pay yet' });

    // Default to paying the full remaining balance if no amount given
    let amount = req.body.amount !== undefined && req.body.amount !== null && req.body.amount !== ''
      ? parseFloat(req.body.amount) : pending;
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount' });
    if (amount > pending + 0.01) return res.status(400).json({ error: `Amount exceeds pending balance of ₹${pending.toFixed(2)}` });

    await pool.query(
      `INSERT INTO session_payments (session_id, amount, paid_by, note) VALUES ($1,$2,$3,$4)`,
      [sess.id, Math.round(amount * 100) / 100, req.user.member_id, req.body.note || null]);

    const money = await getSessionMoney(sess.id);
    const newStatus = money.pending <= 0.01 ? 'paid' : 'partial';

    const { rows } = await pool.query(
      `UPDATE daily_sessions SET status=$1, paid_at=NOW(), paid_by=$2 WHERE id=$3 RETURNING *`,
      [newStatus, req.user.member_id, sess.id]);

    res.json({ ok: true, session: rows[0], amountPaid: money.amountPaid, pending: money.pending });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin, or whoever made the payment: undo a specific payment (mistaken entry)
app.delete('/api/tab/payments/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM session_payments WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Payment not found' });
    if (!req.user.is_admin && rows[0].paid_by !== req.user.member_id)
      return res.status(403).json({ error: 'You can only undo a payment you recorded' });
    const sessionId = rows[0].session_id;
    await pool.query('DELETE FROM session_payments WHERE id=$1', [req.params.id]);

    const money = await getSessionMoney(sessionId);
    const newStatus = money.amountPaid <= 0 ? 'open' : (money.pending <= 0.01 ? 'paid' : 'partial');
    await pool.query('UPDATE daily_sessions SET status=$1 WHERE id=$2', [newStatus, sessionId]);
    res.json({ ok: true, amountPaid: money.amountPaid, pending: money.pending });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: reopen a paid/partial session so items can be added/removed again
app.post('/api/tab/reopen', auth, adminOnly, async (req, res) => {
  try {
    const date = req.body.date || new Date().toISOString().split('T')[0];
    await pool.query(`UPDATE daily_sessions SET status='open' WHERE date=$1`, [date]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Everyone: history of past sessions (aggregate totals only, no per-member breakdown)
app.get('/api/sessions', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT ds.*,
              COALESCE(te.total,0)        as total,
              COALESCE(te.member_count,0) as member_count,
              COALESCE(sp.amount_paid,0)  as amount_paid,
              GREATEST(COALESCE(te.total,0) - COALESCE(sp.amount_paid,0), 0) as pending
       FROM daily_sessions ds
       LEFT JOIN (SELECT session_id, SUM(amount) as total, COUNT(DISTINCT member_id) as member_count
                  FROM tab_entries GROUP BY session_id) te ON te.session_id = ds.id
       LEFT JOIN (SELECT session_id, SUM(amount) as amount_paid
                  FROM session_payments GROUP BY session_id) sp ON sp.session_id = ds.id
       ORDER BY ds.date DESC LIMIT 30`);
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
