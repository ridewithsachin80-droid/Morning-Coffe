-- Morning Accounts Schema

CREATE TABLE IF NOT EXISTS members (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  pin VARCHAR(6) NOT NULL,          -- 4-digit PIN (stored as bcrypt hash in app)
  is_admin BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS items (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  rate NUMERIC(8,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  display_order INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  member_id INT NOT NULL REFERENCES members(id),
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status VARCHAR(20) DEFAULT 'pending',   -- pending | approved | paid
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_by INT REFERENCES members(id),
  reviewed_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  note TEXT,
  UNIQUE(member_id, order_date)           -- one order per member per day
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id INT NOT NULL REFERENCES items(id),
  item_name VARCHAR(100) NOT NULL,        -- snapshot at time of order
  rate NUMERIC(8,2) NOT NULL,             -- snapshot at time of order
  qty INT NOT NULL DEFAULT 0,
  amount NUMERIC(8,2) GENERATED ALWAYS AS (qty * rate) STORED,
  UNIQUE(order_id, item_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(64) PRIMARY KEY,
  member_id INT NOT NULL REFERENCES members(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '12 hours'
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_orders_date   ON orders(order_date);
CREATE INDEX IF NOT EXISTS idx_orders_member ON orders(member_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at);

-- Default items from your Excel
INSERT INTO items (name, rate, display_order) VALUES
  ('Coffee (₹20)',  20, 1),
  ('Coffee (₹15)',  15, 2),
  ('Black Coffee',  15, 3),
  ('Green Tea',     10, 4),
  ('Tea',           15, 5),
  ('Vada',          10, 6),
  ('Maddur Vada',   12, 7),
  ('Bonda',         15, 8),
  ('Thare Idli',    20, 9),
  ('Water',          5, 10)
ON CONFLICT (name) DO NOTHING;

-- Default admin (PIN: 0000)
-- PIN hash is set at runtime via /api/setup
