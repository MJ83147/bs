CREATE TABLE IF NOT EXISTS availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT '',
  slots TEXT NOT NULL,          -- 168-char string of '0'/'1', day-major, day 0 = Sun, hour 0..23 in TCT
  updated_at INTEGER NOT NULL
);
