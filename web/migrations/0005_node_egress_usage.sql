-- Migration number: 0005  2026-09-04T00:00:00.000Z
-- read egressごとの転送量を日次で集計する。追加のみで、既存テーブルには触らない。
--
-- 追加のみにするのは、デプロイが「migration 適用 → Worker 反映」の順で走り、ロールバックは
-- Worker のコードしか戻さないため。旧コードがこれらのテーブルを知らなくても動き続ける形にする。
-- 日次の境界はJST（UTC+9）を仮定しているが、Indigo側の「1日」の境界は未確認。

CREATE TABLE IF NOT EXISTS node_egress_samples (
  node_key TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes_sent INTEGER NOT NULL,
  sampled_at TEXT NOT NULL,
  PRIMARY KEY (node_key, path)
);

CREATE TABLE IF NOT EXISTS node_egress_daily (
  node_key TEXT NOT NULL,
  day TEXT NOT NULL,
  bytes_sent INTEGER NOT NULL DEFAULT 0,
  alerted_level INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (node_key, day)
);
