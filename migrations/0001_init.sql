CREATE TABLE IF NOT EXISTS bankers (
  torn_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  last_poll_ts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS transactions (
  log_id TEXT PRIMARY KEY,
  banker_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  type TEXT NOT NULL,
  item_id INTEGER,
  qty INTEGER NOT NULL DEFAULT 0,
  value_at_time INTEGER NOT NULL DEFAULT 0,
  counterparty_id INTEGER,
  counterparty_name TEXT,
  message TEXT,
  timestamp INTEGER NOT NULL,
  kind TEXT NOT NULL,
  request_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tx_kind ON transactions(kind);
CREATE INDEX IF NOT EXISTS idx_tx_ts ON transactions(timestamp);
CREATE INDEX IF NOT EXISTS idx_tx_item ON transactions(item_id);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  torn_id INTEGER,
  torn_name TEXT,
  item_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  attacks_at_request INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  banker_id INTEGER,
  public_message_id TEXT,
  banker_message_id TEXT,
  decline_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_req_status ON requests(status);

CREATE TABLE IF NOT EXISTS purchases (
  log_id TEXT PRIMARY KEY,
  banker_id INTEGER NOT NULL,
  item_id INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  cost INTEGER NOT NULL,
  source TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  marked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS item_thresholds (
  item_id INTEGER PRIMARY KEY,
  min_attacks INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  item_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  market_value INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO config (key, value) VALUES
  ('keyword', 'BS,donation'),
  ('requests_channel', ''),
  ('log_channel', ''),
  ('bankers_channel', ''),
  ('council_role', ''),
  ('banker_role', ''),
  ('log_types_item_send', '4102'),
  ('log_types_item_receive', '4103'),
  ('log_types_cash_send', '4800'),
  ('log_types_cash_receive', '4810'),
  ('log_types_market_buy', '1112'),
  ('log_types_bazaar_buy', '1225');

CREATE TABLE IF NOT EXISTS players (
  torn_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
