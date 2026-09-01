/** 署名失効後も未確定の pending を failed の反復回収へ引き渡す。 */

import { PRESIGN_EXPIRY_GRACE_MS } from '../infra/r2presign';

/** 署名失効と時計差を越えてから pending を回収対象にする猶予。 */
export const PENDING_RECOVERY_GRACE_MS = PRESIGN_EXPIRY_GRACE_MS;

/** 1 回の実行で failed へ確保する pending 行数の上限。 */
export const MAX_PENDING_CLAIMS_PER_RUN = 150;

interface PendingRetentionDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}

interface ShortIdRow {
  short_id: string;
}

/**
 * 署名失効後の pending を条件付きで failed へ確保する。
 *
 * commit も status = 'pending' を条件にするため、同じ行で勝つのは片方だけ。failed 行は
 * 24 時間残り、後続の sweepFailedObjects が R2 を毎時反復削除する。署名の失効直前に
 * 始まった PUT が最初の delete 後に完了しても、D1 から追跡不能な孤児にはならない。
 */
export async function recoverPendingUploads(
  database: PendingRetentionDatabase,
  now: Date
): Promise<{ recovered: number; skipped: number; capped: boolean }> {
  const threshold = new Date(now.getTime() - PENDING_RECOVERY_GRACE_MS).toISOString();
  const { results } = await database
    .prepare(
      "SELECT short_id FROM movies WHERE status = 'pending' AND datetime(created_at) < datetime(?) LIMIT ?"
    )
    .bind(threshold, MAX_PENDING_CLAIMS_PER_RUN)
    .all<ShortIdRow>();

  let recovered = 0;
  let skipped = 0;
  for (const row of results) {
    const claim = await database
      .prepare(
        "UPDATE movies SET status = 'failed' WHERE short_id = ? AND status = 'pending' AND datetime(created_at) < datetime(?)"
      )
      .bind(row.short_id, threshold)
      .run();
    recovered += claim.meta.changes;
    if (claim.meta.changes === 0) skipped += 1;
  }

  return { recovered, skipped, capped: results.length === MAX_PENDING_CLAIMS_PER_RUN };
}
