-- Migration number: 0001 	 2026-08-25T00:00:00.000Z
-- WebScreen β の初期スキーマ。users（Discord OAuth のログイン主体）と
-- movies（R2 に置いた mp4 のメタデータ）の 2 テーブルのみ。
-- 動画の実体は R2、D1 はメタデータだけを持つ（キー導出は src/lib/contracts/r2key.ts が正本）。

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Discord のユーザー ID。snowflake は 64bit で JS の安全整数を超えるため TEXT で保持する。
  discord_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  avatar TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE movies (
  -- 12 文字 base62 のランダム ID。URL の推測困難性がそのまま公開動画の保護になる
  -- （生成は contracts/r2key.ts の generateShortId が正本）。
  short_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  -- pending: presign 済みで実体未確定 / ready: commit 済み / failed: アップロード失敗
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  -- pin された動画は expires_at による自動削除の対象外にする（0/1 の真偽値）。
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT
);

-- 履歴画面（本人の動画一覧）
CREATE INDEX idx_movies_user_id ON movies (user_id);
-- 未 commit の pending を作成順に掃除するバッチ用
CREATE INDEX idx_movies_status_created_at ON movies (status, created_at);
-- 期限切れ動画の削除バッチ用
CREATE INDEX idx_movies_expires_at ON movies (expires_at);
