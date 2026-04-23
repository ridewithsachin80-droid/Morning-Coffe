-- Morning Accounts Schema (v2 — Coffee Shop Tab)

CREATE TABLE IF NOT EXISTS members (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(100) NOT NULL UNIQUE,
  pin        VARCHAR(60)  NOT NULL,
  is_admin   BOOLEAN DEFAULT FALSE,
  is_active  BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS items (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL UNIQUE,
  rate          NUMERIC(8,2) NOT NULL DEFAULT 0,
  is_active     BOOLEAN DEFAULT TRUE,
  display_order INT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Each row = one "add" action by a member (like a tab line)
CREATE TABLE IF NOT EXISTS tab_entries (
  id          SERIAL PRIMARY KEY,
  session_id  INT NOT NULL,              -- links to daily_session
  member_id   INT NOT NULL REFERENCES members(id),
  item_id     INT REFERENCES items(id),
  item_name   VARCHAR(100) NOT NULL,     -- snapshot
  rate        NUMERIC(8,2) NOT NULL,     -- snapshot
  qty         INT NOT NULL DEFAULT 1,
  amount      NUMERIC(8,2) GENERATED ALWAYS AS (qty * rate) STORED,
  added_at    TIMESTAMPTZ DEFAULT NOW()
);

-- One session per date — admin opens/closes it
CREATE TABLE IF NOT EXISTS daily_sessions (
  id         SERIAL PRIMARY KEY,
  date       DATE NOT NULL UNIQUE DEFAULT CURRENT_DATE,
  status     VARCHAR(20) DEFAULT 'open',   -- open | paid
  total      NUMERIC(10,2) DEFAULT 0,
  paid_at    TIMESTAMPTZ,
  paid_by    INT REFERENCES members(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id         VARCHAR(64) PRIMARY KEY,
  member_id  INT NOT NULL REFERENCES members(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '12 hours'
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tab_session   ON tab_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_tab_member    ON tab_entries(member_id);
CREATE INDEX IF NOT EXISTS idx_tab_added     ON tab_entries(added_at);
CREATE INDEX IF NOT EXISTS idx_session_date  ON daily_sessions(date);

-- Fix PIN column if too small (from v1)
ALTER TABLE members ALTER COLUMN pin TYPE VARCHAR(60);

-- Default items from Excel
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
