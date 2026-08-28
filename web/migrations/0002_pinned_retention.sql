-- Migration number: 0002 	 2026-08-28T00:00:00.000Z
-- pin した動画の保管期間を「無期限」から 365 日へ変更する（期間の正本は
-- src/lib/services/quota.ts の PINNED_RETENTION_MS）。
-- 既存の pin 済み行は expires_at が NULL のままで掃除対象から外れ続けるため、
-- 適用日から 365 日後の期限を入れて通常の retention バッチに乗せる。
-- スキーマは変えないので Worker をロールバックしても壊れない（旧コードは pin 行の
-- expires_at を参照しないだけで、列も制約も増減しない）。
-- 表記は既存の expires_at（ISO8601・UTC）に合わせる。
UPDATE movies
SET expires_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+365 days')
WHERE pinned = 1 AND expires_at IS NULL;
