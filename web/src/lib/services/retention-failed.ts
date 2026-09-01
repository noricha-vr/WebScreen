/** failed アップロードのR2早期回収と24時間後の行削除を扱う。 */

import { movieKey } from '../contracts/r2key';
import { PRESIGN_EXPIRY_GRACE_MS } from '../infra/r2presign';

/** failed 行を残す期間（原因調査のための猶予）。 */
const FAILED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** 署名失効後に遅延 PUT の実体を早期回収するまでの安全余裕。 */
const FAILED_OBJECT_CLEANUP_GRACE_MS = PRESIGN_EXPIRY_GRACE_MS;

/** 1 文の UPDATE / DELETE に載せるID数。D1のバインド変数上限に収める。 */
const MAX_IDS_PER_MUTATION = 50;

/** 1 回の実行で処理する failed 行数の上限。 */
export const MAX_FAILED_DELETIONS_PER_RUN = 500;

interface FailedRetentionDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}

interface FailedRetentionBucket {
  delete(keys: string | string[]): Promise<void>;
}

interface ShortIdRow {
  short_id: string;
}

interface FailedSweepResult {
  deferred: number;
  purged: string[];
  capped: boolean;
}

/** 24時間を過ぎた failed をR2、D1の順に削除する。 */
export async function deleteFailedMovies(
  database: FailedRetentionDatabase,
  bucket: FailedRetentionBucket,
  now: Date
): Promise<FailedSweepResult & { deleted: number }> {
  const threshold = new Date(now.getTime() - FAILED_RETENTION_MS).toISOString();
  const { results } = await database
    .prepare(
      "SELECT short_id FROM movies WHERE status = 'failed' AND datetime(created_at) < datetime(?) LIMIT ?"
    )
    .bind(threshold, MAX_FAILED_DELETIONS_PER_RUN)
    .all<ShortIdRow>();

  const capped = results.length === MAX_FAILED_DELETIONS_PER_RUN;
  if (results.length === 0) return { deleted: 0, deferred: 0, purged: [], capped };

  const shortIds = results.map((row) => row.short_id);
  try {
    await bucket.delete(shortIds.map(movieKey));
  } catch {
    // R2 が落ちている間に行だけ消すと実体が孤児になるため、この実行では行を残す。
    return { deleted: 0, deferred: shortIds.length, purged: [], capped };
  }

  const deleted = await deleteFailedRows(database, shortIds);
  return { deleted, deferred: 0, purged: shortIds, capped };
}

/** 署名失効後の failed 実体だけを早期回収し、D1行を保持する。 */
export async function sweepFailedObjects(
  database: FailedRetentionDatabase,
  bucket: FailedRetentionBucket,
  now: Date,
  recoveredShortIds: string[] = []
): Promise<FailedSweepResult & { swept: number }> {
  const retainedAfter = new Date(now.getTime() - FAILED_RETENTION_MS).toISOString();
  const expiredBefore = new Date(now.getTime() - FAILED_OBJECT_CLEANUP_GRACE_MS).toISOString();
  const sweptAt = now.toISOString();
  // NULL / 通常の未到来期限は未 sweep、過去時刻は最終 sweep として古い順に巡回する。
  // expires_at は除外条件には使わないため、遅延 PUT の完了後も次回以降に再回収できる。
  const { results } = await database
    .prepare(
      "SELECT short_id FROM movies WHERE status = 'failed' AND datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?) ORDER BY CASE WHEN expires_at IS NULL OR datetime(expires_at) > datetime(?) THEN 0 ELSE 1 END, datetime(expires_at), short_id LIMIT ?"
    )
    .bind(retainedAfter, expiredBefore, sweptAt, MAX_FAILED_DELETIONS_PER_RUN)
    .all<ShortIdRow>();

  // 今回 pending から確保した ID は既に failed と確認済みなので、SQL の IN 句へ再投入せず
  // 通常候補とメモリ上で合流する。最大150件を bind すると D1 の100変数上限を超えるため。
  const candidates = new Set([...recoveredShortIds, ...results.map((row) => row.short_id)]);
  const shortIds = [...candidates].slice(0, MAX_FAILED_DELETIONS_PER_RUN);
  const capped = results.length === MAX_FAILED_DELETIONS_PER_RUN || candidates.size > shortIds.length;
  if (shortIds.length === 0) return { swept: 0, deferred: 0, purged: [], capped };
  try {
    // 存在しないキーの delete も成功するため head は不要。行を残し、
    // 削除後に遅延 PUT が完了しても次回 cron で再回収する。
    await bucket.delete(shortIds.map(movieKey));
  } catch {
    return { swept: 0, deferred: shortIds.length, purged: [], capped };
  }

  return { swept: shortIds.length, deferred: 0, purged: shortIds, capped };
}

/** early sweep 成功時刻を巡回順序用に記録する。 */
export async function recordFailedObjectSweep(
  database: FailedRetentionDatabase,
  shortIds: string[],
  sweptAt: Date
): Promise<void> {
  for (const chunk of chunksOf(shortIds)) {
    const placeholders = chunk.map(() => '?').join(', ');
    await database
      .prepare(
        `UPDATE movies SET expires_at = ? WHERE status = 'failed' AND short_id IN (${placeholders})`
      )
      .bind(sweptAt.toISOString(), ...chunk)
      .run();
  }
}

async function deleteFailedRows(
  database: FailedRetentionDatabase,
  shortIds: string[]
): Promise<number> {
  let deleted = 0;
  for (const chunk of chunksOf(shortIds)) {
    const placeholders = chunk.map(() => '?').join(', ');
    const result = await database
      .prepare(`DELETE FROM movies WHERE status = 'failed' AND short_id IN (${placeholders})`)
      .bind(...chunk)
      .run();
    deleted += result.meta.changes;
  }
  return deleted;
}

function chunksOf(shortIds: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < shortIds.length; index += MAX_IDS_PER_MUTATION) {
    chunks.push(shortIds.slice(index, index + MAX_IDS_PER_MUTATION));
  }
  return chunks;
}
