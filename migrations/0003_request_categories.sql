-- Add category to requests and make item_id nullable (bucket requests have no item until fulfilled).
CREATE TABLE requests_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_id TEXT NOT NULL,
  torn_id INTEGER,
  torn_name TEXT,
  item_id INTEGER,
  category TEXT,
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

INSERT INTO requests_new (id, discord_id, torn_id, torn_name, item_id, category, qty, attacks_at_request, status, banker_id, public_message_id, banker_message_id, decline_reason, created_at, updated_at)
  SELECT id, discord_id, torn_id, torn_name, item_id, NULL, qty, attacks_at_request, status, banker_id, public_message_id, banker_message_id, decline_reason, created_at, updated_at FROM requests;

DROP TABLE requests;
ALTER TABLE requests_new RENAME TO requests;
CREATE INDEX IF NOT EXISTS idx_req_status ON requests(status);
