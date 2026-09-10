-- Per-tick snapshots of the Elimination competition standings. One row per team
-- per poll; the /elimination page reads the latest row per team for the live
-- standings and the full window for the score-over-time charts.
CREATE TABLE IF NOT EXISTS elimination_snapshots (
  ts INTEGER NOT NULL,
  team_id INTEGER NOT NULL,
  name TEXT,
  position INTEGER,
  score INTEGER,
  lives INTEGER,
  wins INTEGER,
  losses INTEGER,
  participants INTEGER,
  eliminated INTEGER DEFAULT 0,
  PRIMARY KEY (ts, team_id)
);
CREATE INDEX IF NOT EXISTS elim_team_ts ON elimination_snapshots (team_id, ts);
CREATE INDEX IF NOT EXISTS elim_ts ON elimination_snapshots (ts);
