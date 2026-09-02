-- pagehide と配信作成の順序競合を operation token で解消する。
ALTER TABLE stream_sessions ADD COLUMN start_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_stream_sessions_user_start_token
  ON stream_sessions(user_id, start_token);

CREATE TABLE IF NOT EXISTS stream_start_cancellations (
  user_id INTEGER NOT NULL REFERENCES users(id),
  start_token TEXT NOT NULL,
  cancelled_at TEXT NOT NULL,
  PRIMARY KEY (user_id, start_token)
);

CREATE INDEX IF NOT EXISTS idx_stream_start_cancellations_cancelled_at
  ON stream_start_cancellations(cancelled_at);
