CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  video_file_path TEXT NOT NULL,
  transcript_file_path TEXT,
  status TEXT NOT NULL,
  guest_name TEXT,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  suggested_start_ms REAL,
  suggested_end_ms REAL,
  suggested_score REAL,
  suggested_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_created_at ON jobs(created_at);

CREATE TABLE IF NOT EXISTS word_cloud (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phrase TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_phrase ON word_cloud(phrase);
