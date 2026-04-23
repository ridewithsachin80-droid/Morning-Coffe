require('dotenv').config();
const express      = require('express');
const { Pool }     = require('pg');
const bcrypt       = require('bcryptjs');
const { v4: uuid } = require('uuid');
const cookieParser = require('cookie-parser');
const compression  = require('compression');
const path         = require('path');

// ── Validate DATABASE_URL early ──
if (!process.env.DATABASE_URL) {
  console.error('❌  DATABASE_URL is not set.');
  console.error('    In Railway: open your service → Variables → add DATABASE_URL from your PostgreSQL plugin.');
  process.exit(1);
}

const app = express();

// ── Pool: always rejectUnauthorized:false for Railway/hosted PG ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10,
});
pool.on('error', (err) => console.error('Pool error:', err.message));

app.use(compression());
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════
// DB INIT — retries so Railway PG has time to start
// ══════════════════════════════════════════════════════════════
async function initDB(retries = 8, delay = 3000) {
  const fs = require('fs');
  const schema = fs.readFileSync(path.join(__dirname, 'db/schema.sql'), 'utf8');
  for (let i = 1; i <= retries; i++) {
    try {
      await pool.query(schema);
      console.log('✅ DB schema ready');
      return;
    } catch (e) {
      console.error(`DB connect attempt ${i}/${retries}: ${e.message}`);
      if (i === retries) throw e;
      console.log(`Retrying in ${delay / 1000}s…`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ══════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ══════════════════════════════════════════════════════════════
async function auth(req, res, next) {
  const token = req.cookies.session || req.headers['x-session'];
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    const { rows } = await pool.query(
      `SELECT s.member_id, m.name, m.is_admin, m.is_active
       FROM sessions s JOIN members m ON m.id = s.member_id
       WHERE s.id = $1 AND s.expires_at > NOW()`, [token]);
    if (!rows.length || !rows[0].is_active) return res.status(401).json({ error: 'Session expired' });
    req.user = rows[0];
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

function adminOnly(req, res, next) {
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  next();
}

// ══════════════════════════════════════════════════════════════
// SETUP
// ══════════════════════════════════════════════════════════════
app.post('/api/setup', async (req, res) => {
  try {
    const { adminName, adminPin } = req.body;
    if (!adminName || !adminPin) return res.status(400).json({ error: 'Name and PIN required' });
    const { rows } = await pool.query('SELECT id FROM members WHERE is_admin = TRUE LIMIT 1');
    if (rows.length) return res.status(400).json({ error: 'Admin already exists' });
    const hash = await bcrypt.hash(String(adminPin), 10);
    await pool.query('INSERT INTO members (name, pin, is_admin) VALUES ($1, $2, TRUE)', [adminName, hash]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/setup/status', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM members WHERE is_admin = TRUE LIMIT 1');
    res.json({ setupDone: rows.length > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════════════
app.post('/api/login', async (req, res) => {
  try {
    const { name, pin } = req.body;
    if (!name || !pin) return res.status(400).json({ error: 'Name and PIN required' });
    const { rows } = await pool.query(
      'SELECT * FROM members WHERE LOWER(name) = LOWER($1) AND is_active = TRUE', [name.trim()]);
    if (!rows.length) return res.status(401).json({ error: 'Member not found' });
    const ok = await bcrypt.compare(String(pin), rows[0].pin);
    if (!ok) return res.status(401).json({ error: 'Wrong PIN' });
    const token = uuid();
    await pool.query('INSERT INTO sessions (id, member_id) VALUES ($1, $2)', [token, rows[0].id]);
    await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
    res.cookie('session', token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 });
    res.json({ ok: true, name: rows[0].name, isAdmin: rows[0].is_admin, token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', async (req, res) => {
  const token = req.cookies.session;
  if (token) await pool.query('DELETE FROM sessions WHERE id = $1', [token]);
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => {
  res.json({ name: req.user.name, isAdmin: req.user.is_admin, memberId: req.user.member_id });
});

// ══════════════════════════════════════════════════════════════
// ITEMS
// ══════════════════════════════════════════════════════════════
app.get('/api/items', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM items WHERE is_active = TRUE ORDER BY display_order, id');
  res.json(rows);
});

app.post('/api/items', auth, adminOnly, async (req, res) => {
  try {
    const { name, rate } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO items (name, rate) VALUES ($1, $2) RETURNING *', [name, rate]);
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/items/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, rate, is_active } = req.body;
    const { rows } = await pool.query(
      'UPDATE items SET name=$1, rate=$2, is_active=$3 WHERE id=$4 RETURNING *',
      [name, rate, is_active ?? true, req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/items/:id', auth, adminOnly, async (req, res) => {
  await pool.query('UPDATE items SET is_active = FALSE WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// MEMBERS
// ══════════════════════════════════════════════════════════════
app.get('/api/members', auth, adminOnly, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, is_admin, is_active, created_at FROM members ORDER BY is_admin DESC, name');
  res.json(rows);
});

app.post('/api/members', auth, adminOnly, async (req, res) => {
  try {
    const { name, pin } = req.body;
    if (!name || !pin) return res.status(400).json({ error: 'Name and PIN required' });
    const hash = await bcrypt.hash(String(pin), 10);
    const { rows } = await pool.query(
      'INSERT INTO members (name, pin) VALUES ($1, $2) RETURNING id, name, is_admin, is_active, created_at',
      [name.trim(), hash]);
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: 'Member already exists or DB error' }); }
});

app.put('/api/members/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, pin, is_active } = req.body;
    let query, params;
    if (pin) {
      const hash = await bcrypt.hash(String(pin), 10);
      query  = 'UPDATE members SET name=$1, pin=$2, is_active=$3 WHERE id=$4 RETURNING id,name,is_admin,is_active';
      params = [name, hash, is_active ?? true, req.params.id];
    } else {
      query  = 'UPDATE members SET name=$1, is_active=$2 WHERE id=$3 RETURNING id,name,is_admin,is_active';
      params = [name, is_active ?? true, req.params.id];
    }
    const { rows } = await pool.query(query, params);
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/members/:id', auth, adminOnly, async (req, res) => {
  await pool.query('UPDATE members SET is_active = FALSE WHERE id = $1 AND is_admin = FALSE', [req.params.id]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// ORDERS — MEMBER
// ══════════════════════════════════════════════════════════════
app.get('/api/orders/mine', auth, async (req, res) => {
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const { rows: orders } = await pool.query(
    'SELECT * FROM orders WHERE member_id = $1 AND order_date = $2', [req.user.member_id, date]);
  if (!orders.length) return res.json({ order: null, items: [] });
  const { rows: oi } = await pool.query(
    'SELECT * FROM order_items WHERE order_id = $1', [orders[0].id]);
  res.json({ order: orders[0], items: oi });
});

app.post('/api/orders', auth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const date      = req.body.date || new Date().toISOString().split('T')[0];
    const itemsData = req.body.items;

    const { rows: existing } = await client.query(
      'SELECT id, status FROM orders WHERE member_id = $1 AND order_date = $2',
      [req.user.member_id, date]);

    if (existing.length && existing[0].status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Order already approved/paid and cannot be edited' });
    }

    let orderId;
    if (existing.length) {
      orderId = existing[0].id;
      await client.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);
    } else {
      const { rows } = await client.query(
        'INSERT INTO orders (member_id, order_date) VALUES ($1, $2) RETURNING id',
        [req.user.member_id, date]);
      orderId = rows[0].id;
    }

    for (const it of itemsData) {
      if (!it.qty || it.qty <= 0) continue;
      const { rows: itemRow } = await client.query('SELECT * FROM items WHERE id = $1', [it.item_id]);
      if (!itemRow.length) continue;
      await client.query(
        'INSERT INTO order_items (order_id, item_id, item_name, rate, qty) VALUES ($1,$2,$3,$4,$5)',
        [orderId, it.item_id, itemRow[0].name, itemRow[0].rate, it.qty]);
    }

    await client.query('COMMIT');
    res.json({ ok: true, orderId });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.get('/api/orders/history', auth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.*, COALESCE(SUM(oi.amount),0) as total
     FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.member_id = $1
     GROUP BY o.id ORDER BY o.order_date DESC LIMIT 30`, [req.user.member_id]);
  res.json(rows);
});

// ══════════════════════════════════════════════════════════════
// ORDERS — ADMIN
// ══════════════════════════════════════════════════════════════
app.get('/api/admin/orders', auth, adminOnly, async (req, res) => {
  const { status, from, to, member_id } = req.query;
  let where = ['1=1'], params = [];
  if (status)    { params.push(status);    where.push(`o.status = $${params.length}`); }
  if (from)      { params.push(from);      where.push(`o.order_date >= $${params.length}`); }
  if (to)        { params.push(to);        where.push(`o.order_date <= $${params.length}`); }
  if (member_id) { params.push(member_id); where.push(`o.member_id = $${params.length}`); }

  const { rows } = await pool.query(
    `SELECT o.*, m.name as member_name, COALESCE(SUM(oi.amount),0) as total
     FROM orders o
     JOIN members m ON m.id = o.member_id
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE ${where.join(' AND ')}
     GROUP BY o.id, m.name
     ORDER BY o.order_date DESC, m.name`, params);
  res.json(rows);
});

app.get('/api/admin/orders/:id', auth, adminOnly, async (req, res) => {
  const { rows: order } = await pool.query(
    `SELECT o.*, m.name as member_name FROM orders o JOIN members m ON m.id=o.member_id WHERE o.id=$1`,
    [req.params.id]);
  if (!order.length) return res.status(404).json({ error: 'Not found' });
  const { rows: oi } = await pool.query('SELECT * FROM order_items WHERE order_id=$1', [req.params.id]);
  res.json({ order: order[0], items: oi });
});

app.post('/api/admin/orders/:id/approve', auth, adminOnly, async (req, res) => {
  await pool.query(
    `UPDATE orders SET status='approved', reviewed_by=$1, reviewed_at=NOW() WHERE id=$2`,
    [req.user.member_id, req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/orders/:id/reject', auth, adminOnly, async (req, res) => {
  await pool.query(
    `UPDATE orders SET status='pending', reviewed_by=NULL, reviewed_at=NULL WHERE id=$1`,
    [req.params.id]);
  res.json({ ok: true });
});

app.post('/api/admin/pay', auth, adminOnly, async (req, res) => {
  const { orderIds } = req.body;
  if (!orderIds || !orderIds.length) return res.status(400).json({ error: 'No orders selected' });
  await pool.query(
    `UPDATE orders SET status='paid', paid_at=NOW() WHERE id = ANY($1::int[]) AND status='approved'`,
    [orderIds]);
  res.json({ ok: true });
});

app.get('/api/admin/summary', auth, adminOnly, async (req, res) => {
  const { from, to } = req.query;
  const f = from || new Date().toISOString().split('T')[0];
  const t = to   || new Date().toISOString().split('T')[0];
  const { rows } = await pool.query(
    `SELECT oi.item_name, oi.rate, SUM(oi.qty) as total_qty, SUM(oi.amount) as total_amount, o.status
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.order_date BETWEEN $1 AND $2
     GROUP BY oi.item_name, oi.rate, o.status ORDER BY oi.item_name`, [f, t]);
  const { rows: memberTotals } = await pool.query(
    `SELECT m.name, o.status, COALESCE(SUM(oi.amount),0) as total
     FROM orders o JOIN members m ON m.id = o.member_id
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.order_date BETWEEN $1 AND $2
     GROUP BY m.name, o.status ORDER BY total DESC`, [f, t]);
  res.json({ itemSummary: rows, memberSummary: memberTotals });
});

// ══════════════════════════════════════════════════════════════
// CATCH-ALL → SPA
// ══════════════════════════════════════════════════════════════
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// ══════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`☕ Morning Accounts running on port ${PORT}`)))
  .catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
