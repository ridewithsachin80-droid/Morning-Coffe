require('dotenv').config();
const express      = require('express');
const { Pool }     = require('pg');
const bcrypt       = require('bcryptjs');
const { v4: uuid } = require('uuid');
const cookieParser = require('cookie-parser');
const compression  = require('compression');
const path         = require('path');
const ai           = require('./ai');

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
// ── PWA manifest with auto-versioned icon URLs ──
// Chrome (144+) treats a manifest icon URL as immutable: an installed app only picks up a new icon
// when the URL itself changes. So every icon src gets ?v=<hash of the file>. Swap a PNG in
// public/icons, deploy, and installed phones are offered the new icon — nothing else to remember.
const crypto = require('crypto');
function buildManifest() {
  const fs = require('fs');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'public/manifest.webmanifest'), 'utf8'));
  const stamp = src => {
    try {
      const file = path.join(__dirname, 'public', src.split('?')[0]);
      return `${src.split('?')[0]}?v=${crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10)}`;
    } catch (_) { return src; }
  };
  const walk = icons => (icons || []).forEach(i => { i.src = stamp(i.src); });
  walk(manifest.icons);
  (manifest.shortcuts || []).forEach(sc => walk(sc.icons));
  return JSON.stringify(manifest);
}
const MANIFEST_JSON = buildManifest();   // icons only change on deploy, so compute once at boot
app.get('/manifest.webmanifest', (req, res) => {
  res.set({ 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-cache' }).send(MANIFEST_JSON);
});
// The service worker must never be served stale either
app.get('/sw.js', (req, res, next) => { res.set('Cache-Control', 'no-cache'); next(); });
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
  const { rows } = await pool.query(
    `SELECT i.*, m.name as created_by_name FROM items i LEFT JOIN members m ON m.id = i.created_by
     WHERE i.is_active=TRUE ORDER BY i.display_order, i.id`);
  res.json(rows);
});
app.post('/api/items', auth, adminOnly, async (req, res) => {
  try {
    const { name, rate } = req.body;
    const { rows } = await pool.query('INSERT INTO items (name,rate) VALUES ($1,$2) RETURNING *', [name, rate]);
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// Any member: add a missing item to the menu while ordering (AI flow — "masala dosa, 50 rupees").
// Add-only: editing rates and removing items stays admin-only. If the name already exists it is
// reused (and re-activated if it had been removed) instead of creating a duplicate.
app.post('/api/items/quick', auth, async (req, res) => {
  try {
    const name = String(req.body.name || '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const rate = Math.round(parseFloat(req.body.rate) * 100) / 100;
    if (name.length < 2) return res.status(400).json({ error: 'Item name required' });
    if (!Number.isFinite(rate) || rate <= 0 || rate > 5000) return res.status(400).json({ error: `Enter a valid rate for ${name}` });

    const { rows: ex } = await pool.query('SELECT * FROM items WHERE LOWER(name)=LOWER($1)', [name]);
    if (ex.length) {
      if (ex[0].is_active) return res.json({ ...ex[0], existed: true });
      const { rows } = await pool.query('UPDATE items SET is_active=TRUE, rate=$1 WHERE id=$2 RETURNING *', [rate, ex[0].id]);
      return res.json({ ...rows[0], reactivated: true });
    }
    const { rows: cnt } = await pool.query(
      `SELECT COUNT(*)::int as n FROM items WHERE created_by=$1 AND created_at > NOW() - INTERVAL '1 day'`, [req.user.member_id]);
    if (!req.user.is_admin && cnt[0].n >= 15) return res.status(429).json({ error: 'Too many new items today — ask the admin to add it' });
    const { rows: mx } = await pool.query('SELECT COALESCE(MAX(display_order),0)+1 as o FROM items');
    const { rows } = await pool.query(
      'INSERT INTO items (name,rate,display_order,created_by) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, rate, mx[0].o, req.user.member_id]);
    res.json(rows[0]);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/items/:id', auth, adminOnly, async (req, res) => {
  try {
    const { name, rate, is_active } = req.body;
    const { rows } = await pool.query(
      'UPDATE items SET name=$1,rate=$2,is_active=$3 WHERE id=$4 RETURNING *',
      [name, rate, is_active ?? true, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    // A corrected name/rate also fixes lines on rounds that are still OPEN (nothing paid yet).
    // Partial/paid rounds keep their snapshot so settled bills never change.
    const upd = await pool.query(
      `UPDATE tab_entries te SET item_name=$1, rate=$2
       FROM daily_sessions ds
       WHERE ds.id = te.session_id AND ds.status='open' AND te.item_id=$3
         AND (te.item_name <> $1 OR te.rate <> $2)`, [rows[0].name, rows[0].rate, rows[0].id]);
    res.json({ ...rows[0], openEntriesUpdated: upd.rowCount });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/items/:id', auth, adminOnly, async (req, res) => {
  await pool.query('UPDATE items SET is_active=FALSE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

// ── MEMBERS ──
// Everyone: lightweight id+name list, so an order can be added on behalf of a colleague
app.get('/api/members/names', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id,name FROM members WHERE is_active=TRUE ORDER BY name');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
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

// ── SESSION (daily, supports multiple rounds per date) ──

// Read-only: the currently open round for a date, if any
async function getOpenSession(date) {
  const { rows } = await pool.query(
    `SELECT * FROM daily_sessions WHERE date=$1 AND status='open' ORDER BY round_no DESC LIMIT 1`, [date]);
  return rows[0] || null;
}

// Read-only: every round recorded for a date, oldest first
async function listSessionsForDate(date) {
  const { rows } = await pool.query(
    `SELECT * FROM daily_sessions WHERE date=$1 ORDER BY round_no`, [date]);
  return rows;
}

// Read-only: a specific round by id
async function getSessionById(id) {
  const { rows } = await pool.query('SELECT * FROM daily_sessions WHERE id=$1', [id]);
  return rows[0] || null;
}

// The only place a new round gets created: when someone actually adds an item.
// Reuses the open round for the date if one exists, otherwise starts the next round.
async function getOrCreateOpenSession(date) {
  const open = await getOpenSession(date);
  if (open) return open;
  const { rows: mx } = await pool.query(
    'SELECT COALESCE(MAX(round_no),0) as m FROM daily_sessions WHERE date=$1', [date]);
  const { rows } = await pool.query(
    'INSERT INTO daily_sessions (date, round_no) VALUES ($1,$2) RETURNING *',
    [date, mx[0].m + 1]);
  return rows[0];
}

// Resolve "which session are we talking about" from a request: prefer an explicit
// session_id, fall back to the open round for the date, fall back to the latest round.
async function resolveSession(query) {
  if (query.session_id) return getSessionById(query.session_id);
  const date = query.date || new Date().toISOString().split('T')[0];
  const open = await getOpenSession(date);
  if (open) return open;
  const all = await listSessionsForDate(date);
  return all.length ? all[all.length - 1] : null;
}

// Format a DB DATE value (which pg returns as a JS Date) as YYYY-MM-DD
function dateStr(d) {
  return d instanceof Date ? d.toISOString().split('T')[0] : String(d).substring(0, 10);
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

// Current group-wide advance/credit balance (from overpayments to the coffee shop)
async function getAdvanceBalance() {
  const { rows } = await pool.query('SELECT COALESCE(SUM(amount),0) as bal FROM advance_ledger');
  return Math.round(parseFloat(rows[0].bal) * 100) / 100;
}

// Read-only status check for the "Add Items" banner — never creates a round
app.get('/api/session/today', auth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const open = await getOpenSession(date);
    if (open) return res.json(open);
    const all = await listSessionsForDate(date);
    res.json({ status: 'none', round_no: all.length + 1, date, lastRound: all[all.length - 1] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List every round recorded for a date, with totals — powers the round picker in the UI
app.get('/api/sessions/by-date', auth, async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().split('T')[0];
    const sessions = await listSessionsForDate(date);
    const withMoney = await Promise.all(sessions.map(async s => {
      const money = await getSessionMoney(s.id);
      return { ...s, ...money };
    }));
    res.json(withMoney);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TAB ENTRIES ──

// Member adds item(s) — can call multiple times. Always lands in the open round
// for that date; if the latest round there is locked (payment started), a new
// round is started automatically.
app.post('/api/tab', auth, async (req, res) => {
  try {
    const date    = req.body.date || new Date().toISOString().split('T')[0];
    const entries = req.body.entries; // [{ item_id, qty, member_id? }]  member_id omitted = me
    if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'No items provided' });
    const source  = ['tap', 'voice', 'text'].includes(req.body.source) ? req.body.source : 'tap';

    // Validate everything BEFORE opening a round, so a bad request never creates an empty round
    const { rows: activeMembers } = await pool.query('SELECT id FROM members WHERE is_active=TRUE');
    const memberIds = new Set(activeMembers.map(m => m.id));
    const valid = [];
    for (const e of entries) {
      const qty = parseInt(e.qty, 10);
      if (!Number.isFinite(qty) || qty <= 0 || qty > 50) continue;
      const { rows: item } = await pool.query('SELECT * FROM items WHERE id=$1 AND is_active=TRUE', [e.item_id]);
      if (!item.length) continue;
      const forMember = e.member_id ? parseInt(e.member_id, 10) : req.user.member_id;
      if (!memberIds.has(forMember)) return res.status(400).json({ error: 'Unknown or inactive member in order' });
      valid.push({ item: item[0], qty, forMember });
    }
    if (!valid.length) return res.status(400).json({ error: 'No valid items in order' });

    const sess = await getOrCreateOpenSession(date);
    const inserted = [];
    for (const v of valid) {
      const { rows } = await pool.query(
        `INSERT INTO tab_entries (session_id,member_id,item_id,item_name,rate,qty,added_by,source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [sess.id, v.forMember, v.item.id, v.item.name, v.item.rate, v.qty, req.user.member_id, source]);
      inserted.push(rows[0]);
    }
    res.json({ ok: true, entries: inserted, session: sess });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Who may change a tab line: admin, the member it belongs to, or whoever entered it
function canTouchEntry(user, entry) {
  return user.is_admin || entry.member_id === user.member_id || entry.added_by === user.member_id;
}

// Edit a tab entry added by mistake: change qty, swap the item, or move it to another member.
// Only while the round is open — once payment has started the admin must reopen the round first.
app.put('/api/tab/:id', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT te.*, ds.status FROM tab_entries te JOIN daily_sessions ds ON ds.id=te.session_id WHERE te.id=$1',
      [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const entry = rows[0];
    if (entry.status !== 'open') return res.status(400).json({ error: 'Round is locked — payment already started' + (req.user.is_admin ? '. Reopen the round to edit.' : '') });
    if (!canTouchEntry(req.user, entry)) return res.status(403).json({ error: 'Not your entry' });

    let { qty, item_id, member_id } = req.body;
    let itemName = entry.item_name, rate = entry.rate, itemId = entry.item_id, memberId = entry.member_id;
    qty = qty === undefined ? entry.qty : parseInt(qty, 10);
    if (!Number.isFinite(qty) || qty < 1 || qty > 50) return res.status(400).json({ error: 'Quantity must be 1–50' });

    if (item_id !== undefined && Number(item_id) !== entry.item_id) {
      const { rows: it } = await pool.query('SELECT * FROM items WHERE id=$1 AND is_active=TRUE', [item_id]);
      if (!it.length) return res.status(400).json({ error: 'Item not on the menu' });
      itemId = it[0].id; itemName = it[0].name; rate = it[0].rate;
    }
    if (member_id !== undefined && Number(member_id) !== entry.member_id) {
      const { rows: mm } = await pool.query('SELECT id FROM members WHERE id=$1 AND is_active=TRUE', [member_id]);
      if (!mm.length) return res.status(400).json({ error: 'Unknown or inactive member' });
      memberId = mm[0].id;
    }
    const { rows: out } = await pool.query(
      'UPDATE tab_entries SET qty=$1,item_id=$2,item_name=$3,rate=$4,member_id=$5 WHERE id=$6 RETURNING *',
      [qty, itemId, itemName, rate, memberId, entry.id]);
    res.json(out[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Everything I can fix in the current round: my own lines + lines I entered for others
app.get('/api/tab/touched', auth, async (req, res) => {
  try {
    const sess = await resolveSession(req.query);
    if (!sess) return res.json({ session: null, entries: [] });
    const { rows } = await pool.query(
      `SELECT te.*, m.name as member_name, ab.name as added_by_name
       FROM tab_entries te JOIN members m ON m.id = te.member_id LEFT JOIN members ab ON ab.id = te.added_by
       WHERE te.session_id=$1 AND (te.member_id=$2 OR te.added_by=$2)
       ORDER BY te.added_at DESC`, [sess.id, req.user.member_id]);
    res.json({ session: sess, entries: rows });
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
    // You can remove your own entries, and entries you added on someone else's behalf
    if (!canTouchEntry(req.user, rows[0])) return res.status(403).json({ error: 'Not your entry' });
    await pool.query('DELETE FROM tab_entries WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Member: get my tab for a date/round
app.get('/api/tab/mine', auth, async (req, res) => {
  try {
    const sess = await resolveSession(req.query);
    if (!sess) return res.json({ session: null, entries: [], total: 0 });
    const { rows } = await pool.query(
      `SELECT te.*, ab.name as added_by_name
       FROM tab_entries te LEFT JOIN members ab ON ab.id = te.added_by
       WHERE te.session_id=$1 AND te.member_id=$2 ORDER BY te.added_at`,
      [sess.id, req.user.member_id]);
    const total = rows.reduce((s, r) => s + parseFloat(r.amount), 0);
    res.json({ session: sess, entries: rows, total });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Everyone: get full tab for a date/round (all members) — needed so anyone can view & pay the bill
app.get('/api/tab/all', auth, async (req, res) => {
  try {
    const sess = await resolveSession(req.query);
    if (!sess) return res.json({ session: null, byMember: {}, itemSummary: {}, grandTotal: 0, entryCount: 0, payments: [], amountPaid: 0, pending: 0 });

    const { rows: entries } = await pool.query(
      `SELECT te.*, m.name as member_name, ab.name as added_by_name
       FROM tab_entries te
       JOIN members m ON m.id=te.member_id
       LEFT JOIN members ab ON ab.id=te.added_by
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
    const advanceBalance = await getAdvanceBalance();

    res.json({ session: sess, byMember, itemSummary, grandTotal, entryCount: entries.length, payments, amountPaid, pending, advanceBalance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Any member: record a payment against a session (full or partial). Paying more
// than the pending balance is allowed — the excess becomes advance credit that
// can be applied to future rounds instead of being rejected.
app.post('/api/tab/pay', auth, async (req, res) => {
  try {
    const sess = await resolveSession(req.body);
    if (!sess) return res.status(404).json({ error: 'No session found to pay' });

    const { grandTotal, pending } = await getSessionMoney(sess.id);
    if (grandTotal <= 0) return res.status(400).json({ error: 'Nothing to pay yet' });
    if (pending <= 0 && (req.body.amount === undefined || req.body.amount === null || req.body.amount === ''))
      return res.status(400).json({ error: 'This round is already fully paid — enter an amount to record it as advance credit' });

    let amount = req.body.amount !== undefined && req.body.amount !== null && req.body.amount !== ''
      ? parseFloat(req.body.amount) : pending;
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount' });

    const payerName = (req.body.payer_name && req.body.payer_name.trim()) || req.user.name;
    const note = req.body.note || null;
    const applyToRound = Math.round(Math.min(amount, pending) * 100) / 100;
    const excess = Math.round((amount - applyToRound) * 100) / 100;

    if (applyToRound > 0) {
      await pool.query(
        `INSERT INTO session_payments (session_id, amount, paid_by, payer_name, note) VALUES ($1,$2,$3,$4,$5)`,
        [sess.id, applyToRound, req.user.member_id, payerName, note]);
    }
    if (excess > 0) {
      await pool.query(
        `INSERT INTO advance_ledger (amount, session_id, payer_name, note) VALUES ($1,$2,$3,$4)`,
        [excess, sess.id, payerName, note || `Overpayment on ${dateStr(sess.date)} Round ${sess.round_no}`]);
    }

    const money = await getSessionMoney(sess.id);
    const newStatus = money.pending <= 0.01 ? 'paid' : 'partial';
    const { rows } = await pool.query(
      `UPDATE daily_sessions SET status=$1, paid_at=NOW(), paid_by=$2 WHERE id=$3 RETURNING *`,
      [newStatus, req.user.member_id, sess.id]);

    const advanceBalance = await getAdvanceBalance();
    res.json({ ok: true, session: rows[0], amountPaid: money.amountPaid, pending: money.pending, excess, advanceBalance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Any member: apply available advance credit toward a round's pending balance
app.post('/api/tab/apply-advance', auth, async (req, res) => {
  try {
    const sess = await resolveSession(req.body);
    if (!sess) return res.status(404).json({ error: 'No session found' });
    const { pending } = await getSessionMoney(sess.id);
    if (pending <= 0) return res.status(400).json({ error: 'Nothing pending on this round' });

    const available = await getAdvanceBalance();
    if (available <= 0) return res.status(400).json({ error: 'No advance credit available' });

    let amount = req.body.amount !== undefined && req.body.amount !== null && req.body.amount !== ''
      ? parseFloat(req.body.amount) : Math.min(available, pending);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Enter a valid amount' });
    if (amount > available + 0.01) return res.status(400).json({ error: `Only ₹${available.toFixed(2)} advance credit available` });
    if (amount > pending + 0.01) return res.status(400).json({ error: `Amount exceeds pending balance of ₹${pending.toFixed(2)}` });
    amount = Math.round(amount * 100) / 100;

    await pool.query(
      `INSERT INTO session_payments (session_id, amount, paid_by, payer_name, note) VALUES ($1,$2,$3,'Advance Credit','Applied from advance credit')`,
      [sess.id, amount, req.user.member_id]);
    await pool.query(
      `INSERT INTO advance_ledger (amount, session_id, note) VALUES ($1,$2,$3)`,
      [-amount, sess.id, `Applied to ${dateStr(sess.date)} Round ${sess.round_no}`]);

    const money = await getSessionMoney(sess.id);
    const newStatus = money.pending <= 0.01 ? 'paid' : 'partial';
    const { rows } = await pool.query(
      `UPDATE daily_sessions SET status=$1, paid_at=NOW(), paid_by=$2 WHERE id=$3 RETURNING *`,
      [newStatus, req.user.member_id, sess.id]);

    const advanceBalance = await getAdvanceBalance();
    res.json({ ok: true, session: rows[0], amountPaid: money.amountPaid, pending: money.pending, advanceBalance });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Everyone: current advance balance + recent ledger history
app.get('/api/advance', auth, async (req, res) => {
  try {
    const balance = await getAdvanceBalance();
    const { rows } = await pool.query(
      `SELECT al.*, ds.date, ds.round_no FROM advance_ledger al
       LEFT JOIN daily_sessions ds ON ds.id = al.session_id
       ORDER BY al.created_at DESC LIMIT 50`);
    res.json({ balance, ledger: rows });
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

// Admin: reopen a paid/partial round so items can be added/removed again.
// Only the latest round for a date can be reopened — keeps "one open round per date" simple.
app.post('/api/tab/reopen', auth, adminOnly, async (req, res) => {
  try {
    const sess = await resolveSession(req.body);
    if (!sess) return res.status(404).json({ error: 'No session found to reopen' });
    const all = await listSessionsForDate(dateStr(sess.date));
    const latest = all[all.length - 1];
    if (latest.id !== sess.id) return res.status(400).json({ error: 'A newer round already exists for this date — only the latest round can be reopened' });
    await pool.query(`UPDATE daily_sessions SET status='open' WHERE id=$1`, [sess.id]);
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
       ORDER BY ds.date DESC, ds.round_no DESC LIMIT 30`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Everyone: date-range report — totals, item breakdown, payer breakdown, advance activity
app.get('/api/reports', auth, async (req, res) => {
  try {
    const to   = req.query.to   || new Date().toISOString().split('T')[0];
    const from = req.query.from || to;

    // Per-round totals within range
    const { rows: sessions } = await pool.query(
      `SELECT ds.id, ds.date, ds.round_no, ds.status,
              COALESCE(te.total,0) as total,
              COALESCE(sp.paid,0)  as paid
       FROM daily_sessions ds
       LEFT JOIN (SELECT session_id, SUM(amount) as total FROM tab_entries GROUP BY session_id) te ON te.session_id = ds.id
       LEFT JOIN (SELECT session_id, SUM(amount) as paid  FROM session_payments GROUP BY session_id) sp ON sp.session_id = ds.id
       WHERE ds.date BETWEEN $1 AND $2
       ORDER BY ds.date, ds.round_no`, [from, to]);

    // Item-wise breakdown across the range
    const { rows: items } = await pool.query(
      `SELECT te.item_name, SUM(te.qty) as qty, SUM(te.amount) as amount
       FROM tab_entries te JOIN daily_sessions ds ON ds.id = te.session_id
       WHERE ds.date BETWEEN $1 AND $2
       GROUP BY te.item_name ORDER BY amount DESC`, [from, to]);

    // Payer-wise breakdown across the range (free-text payer name, so multiple payers per day/round are captured)
    const { rows: payers } = await pool.query(
      `SELECT COALESCE(sp.payer_name, m.name, 'Unknown') as payer_name, SUM(sp.amount) as amount, COUNT(*) as payment_count
       FROM session_payments sp
       JOIN daily_sessions ds ON ds.id = sp.session_id
       LEFT JOIN members m ON m.id = sp.paid_by
       WHERE ds.date BETWEEN $1 AND $2
       GROUP BY COALESCE(sp.payer_name, m.name, 'Unknown') ORDER BY amount DESC`, [from, to]);

    // Advance credit added/used within range
    const { rows: advRows } = await pool.query(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE amount > 0),0) as added,
              COALESCE(SUM(-amount) FILTER (WHERE amount < 0),0) as used
       FROM advance_ledger WHERE created_at::date BETWEEN $1 AND $2`, [from, to]);

    const totalBill    = sessions.reduce((s,x)=>s+parseFloat(x.total),0);
    const totalPaid    = sessions.reduce((s,x)=>s+parseFloat(x.paid),0);
    const totalPending = Math.max(0, Math.round((totalBill - totalPaid) * 100) / 100);
    const advanceBalance = await getAdvanceBalance();

    res.json({
      from, to,
      totalBill: Math.round(totalBill*100)/100,
      totalPaid: Math.round(totalPaid*100)/100,
      totalPending,
      roundCount: sessions.length,
      sessions,
      items,
      payers,
      advanceAdded: parseFloat(advRows[0].added),
      advanceUsed: parseFloat(advRows[0].used),
      advanceBalance
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI: voice / typed order understanding ──
// These endpoints only *interpret* an order and return suggested lines.
// Nothing is saved until the user confirms and the client calls POST /api/tab.

// Small per-member limiter so a stuck mic button can't burn through the AI quota
const aiHits = new Map();
function aiLimit(req, res, next) {
  const now = Date.now(), id = req.user.member_id;
  const hits = (aiHits.get(id) || []).filter(t => now - t < 60000);
  if (hits.length >= 20) return res.status(429).json({ error: 'Too many AI requests — wait a minute and try again' });
  hits.push(now); aiHits.set(id, hits);
  next();
}

// Everything the parser needs to know: menu, members, habits, the speaker's last order
async function buildAiContext(user) {
  const [{ rows: items }, { rows: members }, { rows: usualRows }, { rows: lastRows }] = await Promise.all([
    pool.query('SELECT id,name,rate FROM items WHERE is_active=TRUE ORDER BY display_order,id'),
    pool.query('SELECT id,name FROM members WHERE is_active=TRUE ORDER BY name'),
    pool.query(
      `SELECT te.member_id, te.item_id, SUM(te.qty) as n
       FROM tab_entries te JOIN items i ON i.id = te.item_id AND i.is_active=TRUE
       WHERE te.added_at > NOW() - INTERVAL '60 days'
       GROUP BY te.member_id, te.item_id ORDER BY te.member_id, n DESC`),
    pool.query(
      `SELECT te.item_id, SUM(te.qty)::int as qty
       FROM tab_entries te JOIN items i ON i.id = te.item_id AND i.is_active=TRUE
       WHERE te.member_id=$1 AND te.session_id = (
         SELECT session_id FROM tab_entries WHERE member_id=$1 ORDER BY added_at DESC LIMIT 1)
       GROUP BY te.item_id`, [user.member_id]),
  ]);
  const usuals = {};
  for (const r of usualRows) {
    if (!usuals[r.member_id]) usuals[r.member_id] = [];
    if (usuals[r.member_id].length < 3) usuals[r.member_id].push({ item_id: r.item_id });
  }
  return { items, members, usuals, lastOrder: lastRows, speaker: { id: user.member_id, name: user.name } };
}

app.get('/api/ai/status', auth, (req, res) => res.json(ai.status()));

// Typed order (or text dictated by the browser's own speech recognition)
app.post('/api/ai/text', auth, aiLimit, async (req, res) => {
  try {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Say or type what you had' });
    res.json(await ai.parseText(text, await buildAiContext(req.user)));
  } catch (e) { console.error('AI text error:', e.message); res.status(500).json({ error: 'Could not understand that — try again' }); }
});

// Recorded audio, sent as the raw request body (Content-Type: audio/*)
app.post('/api/ai/voice', auth, aiLimit,
  express.raw({ type: req => /^(audio\/|video\/webm|application\/octet-stream)/i.test(req.headers['content-type'] || ''), limit: '8mb' }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length < 800)
        return res.status(400).json({ error: "Didn't catch anything — hold the mic a little longer" });
      const lang = ['auto', 'en', 'kn', 'hi'].includes(req.query.lang) ? req.query.lang : 'auto';
      const out = await ai.parseAudio(req.body, req.headers['content-type'], await buildAiContext(req.user), lang);
      res.json(out);
    } catch (e) {
      console.error('AI voice error:', e.message, e.detail || '');
      res.status(e.code === 'NO_STT' ? 503 : 500).json({ error: e.message, code: e.code || 'AI_ERROR' });
    }
  });

// ── CATCH-ALL ──
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

// ── START ──
const PORT = process.env.PORT || 3000;
initDB()
  .then(() => app.listen(PORT, () => console.log(`☕ Morning Accounts on port ${PORT}`)))
  .catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
