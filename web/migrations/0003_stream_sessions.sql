-- 配信セッション。既存テーブルを変更せず追加だけで導入する。
CREATE TABLE IF NOT EXISTS stream_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('live', 'ended')),
  started_at TEXT NOT NULL,
  extend_expires_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  last_viewer_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT CHECK (
    end_reason IS NULL OR end_reason IN ('extend_timeout', 'no_viewers', 'heartbeat_lost', 'user_stop')
  ),
  kick_pending INTEGER NOT NULL DEFAULT 0 CHECK (kick_pending IN (0, 1)),
  CHECK (
    (status = 'live' AND ended_at IS NULL AND end_reason IS NULL)
    OR (status = 'ended' AND ended_at IS NOT NULL AND end_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_stream_sessions_user_status
  ON stream_sessions(user_id, status, started_at);

CREATE INDEX IF NOT EXISTS idx_stream_sessions_lifecycle
  ON stream_sessions(status, kick_pending, extend_expires_at);
