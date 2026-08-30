-- Migration number: 0002 	 2026-08-31T00:00:00.000Z
-- cron の死活監視（dead-man's switch）用のテーブル。追加のみで、既存のテーブルには触らない。
--
-- 追加のみにするのは、デプロイが「migration 適用 → Worker 反映」の順で走り、ロールバックは
-- Worker のコードしか戻さないため。旧コードがこのテーブルを知らなくても動き続ける形にする。

-- 1 行 1 ジョブ。行の意味は name ごとに決まる:
--   'retention'       … 保持期間バッチ本体。last_success_at = 最後に成功した実行の基準時刻、
--                       last_summary = その実行の件数 JSON（RetentionSummary）。
--   'retention-alert' … 上の鮮度を見張る通知側。last_success_at = 最後に通知を送った時刻、
--                       last_summary = 通知の状態 JSON（{"state":"alerting"|"recovered"}）。
-- 時刻は ISO8601（UTC, Z 付き）で書く。読み書きは services/cron-health.ts が正本。
CREATE TABLE IF NOT EXISTS cron_runs (
  name TEXT PRIMARY KEY,
  last_success_at TEXT NOT NULL,
  last_summary TEXT
);
