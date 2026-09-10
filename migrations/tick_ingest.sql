CREATE TABLE IF NOT EXISTS tick_periods (
  period_start INTEGER PRIMARY KEY,
  period_end INTEGER NOT NULL,
  event TEXT,
  attacks INTEGER,
  active_players INTEGER,
  matched_players INTEGER,
  complete_coverage INTEGER,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tick_hits (
  period_start INTEGER NOT NULL,
  player_id INTEGER NOT NULL,
  name TEXT,
  bucket TEXT NOT NULL,
  increments INTEGER NOT NULL,
  counter_before INTEGER,
  counter_after INTEGER,
  observation_start TEXT,
  observation_end TEXT,
  PRIMARY KEY (period_start, player_id, bucket)
);
CREATE INDEX IF NOT EXISTS tick_hits_player ON tick_hits (player_id, period_start);
