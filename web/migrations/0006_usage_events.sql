-- Migration number: 0006 	 2026-09-08T00:00:00.000Z
-- 利用ログ。動画（movies の行と R2 の実体）は保持期間（30 日、pin で 1 年）で消えるため、
-- 消えた後も「誰が・いつ・何を・どれだけ」使ったかを追える追記専用のテーブルを持つ。
-- 追加のみで、既存のテーブルは列の追加だけ（デプロイは migration → Worker の順で、
-- ロールバックは Worker のコードしか戻らない。旧コードがこの列とテーブルを知らなくても動く）。

-- 変換元の種別（pdf / image / web）。presign 時に書く。旧コードの INSERT は列を明示しているので
-- NULL のまま入り、集計では「不明」として扱う。値の正本は contracts/api.ts の UPLOAD_KINDS。
ALTER TABLE movies ADD COLUMN kind TEXT;

-- 1 行 1 出来事。行は消さない（保持期間バッチの対象外）。
--   login          … Discord ログイン成功（short_id / kind / size_bytes は NULL）
--   movie_ready    … 変換した動画が公開された（commit 成功）
--   movie_deleted  … 本人が削除した
--   movie_expired  … 保持期間バッチが期限切れで消した
--   movie_pinned / movie_unpinned … 保管延長の切替
-- 読み書きは services/usage-log.ts が正本。集計は make usage-report。
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  event TEXT NOT NULL CHECK (
    event IN ('login', 'movie_ready', 'movie_deleted', 'movie_expired', 'movie_pinned', 'movie_unpinned')
  ),
  -- movies.short_id。行が消えた後も残すため外部キーにしない
  short_id TEXT,
  kind TEXT,
  size_bytes INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ユーザー別の利用履歴（誰がどれだけ使ったか）
CREATE INDEX IF NOT EXISTS idx_usage_events_user_created ON usage_events (user_id, created_at);
-- 出来事別の推移（日次の変換数など）
CREATE INDEX IF NOT EXISTS idx_usage_events_event_created ON usage_events (event, created_at);
