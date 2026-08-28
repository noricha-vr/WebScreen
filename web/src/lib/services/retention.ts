/**
 * 保持期間バッチ（期限切れ動画・孤児・失敗行・キャプチャの掃除）。
 *
 * D1 / R2 はインターフェースで注入し、現在時刻も引数で受け取る（Date.now を呼ぶのは
 * cron の entry 層だけ）。これで workerd なしでも全分岐をテストできる。
 *
 * 削除の順序は必ず「R2 → D1」。逆にすると D1 の行を消した時点で R2 のキーを
 * 導出できなくなり、実体だけが残って回収不能になる（R2 の delete は存在しない
 * キーでも成功するため、この順序なら途中失敗しても次回実行でやり直せる）。
 */

import { movieKey } from '../contracts/r2key';

/** pending のまま放置された予約を孤児とみなすまでの猶予。 */
const PENDING_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** failed 行を残す期間（原因調査のための猶予）。 */
const FAILED_RETENTION_MS = 24 * 60 * 60 * 1000;

/** captures/ の中間生成物を残す期間。動画化が終われば不要になる。 */
const CAPTURE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * 1 回の実行で削除するキャプチャの上限。R2 の list / delete は subrequest を
 * 消費するため、1 回で消し切ろうとせず毎時の実行で分割して処理する。
 */
export const MAX_CAPTURE_DELETIONS_PER_RUN = 1000;

/**
 * キャプチャの R2 prefix。キー規則の正本は contracts/r2key.ts の captureKey で、
 * ここは list 用の prefix だけを持つ（一致は retention のテストで検証する）。
 */
export const CAPTURE_KEY_PREFIX = 'captures/';

/** D1 の最小操作面。バッチが必要とするのは all / run だけ。 */
export interface RetentionDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}

/** R2 の list が返すオブジェクト（バッチが見るのはキーとアップロード時刻だけ）。 */
export interface RetentionObject {
  key: string;
  uploaded: Date;
}

export interface RetentionListResult {
  objects: RetentionObject[];
  truncated: boolean;
  cursor?: string;
}

/** R2 の最小操作面。delete は R2Bucket と同じく複数キーをまとめて受ける。 */
export interface RetentionBucket {
  head(key: string): Promise<{ size: number } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<RetentionListResult>;
}

/** 1 回の実行で削除した件数。cron の構造化ログにそのまま載せる。 */
export interface RetentionSummary {
  deletedMovies: number;
  deletedOrphans: number;
  deletedFailed: number;
  deletedCaptures: number;
}

export interface RetentionInput {
  database: RetentionDatabase;
  bucket: RetentionBucket;
  /** バッチの基準時刻。cron の scheduledTime を渡す。 */
  now: Date;
}

interface ShortIdRow {
  short_id: string;
}

/**
 * 期限切れ動画・孤児・失敗行・古いキャプチャをまとめて掃除する。
 *
 * 段階ごとに独立しているため直列に実行する（並列にしても D1 の待ち時間は
 * 縮まらず、subrequest のバーストだけが増える）。
 */
export async function runRetention(input: RetentionInput): Promise<RetentionSummary> {
  const { database, bucket, now } = input;

  return {
    deletedMovies: await deleteExpiredMovies(database, bucket, now),
    deletedOrphans: await deletePendingOrphans(database, bucket, now),
    deletedFailed: await deleteFailedMovies(database, now),
    deletedCaptures: await deleteStaleCaptures(bucket, now),
  };
}

/**
 * expires_at を過ぎた ready 動画を削除する。pin の有無では絞らない
 * （pin は保管期間を 365 日へ延ばすだけで、期限が来れば同じように消える）。
 *
 * 比較で datetime() を挟むのは、expires_at が ISO8601（`2026-...T...Z`）、
 * created_at が SQLite の datetime('now')（`2026-... ...`）と表記が混在しており、
 * 素の文字列比較では大小が逆転するため。idx_movies_expires_at は効かなくなるが、
 * β 規模の行数では実測差が出ないので正しさを優先する。
 */
async function deleteExpiredMovies(
  database: RetentionDatabase,
  bucket: RetentionBucket,
  now: Date
): Promise<number> {
  const threshold = now.toISOString();
  const { results } = await database
    .prepare(
      "SELECT short_id FROM movies WHERE status = 'ready' AND expires_at IS NOT NULL AND datetime(expires_at) < datetime(?)"
    )
    .bind(threshold)
    .all<ShortIdRow>();

  let deleted = 0;
  for (const row of results) {
    // 初回 SELECT の後に pin（= 期限の延長）が入った場合、R2 を先に消すと生きた
    // 行だけが残る。R2 削除の直前にも期限を読み直し、実体と行の不整合を防ぐ。
    const current = await database
      .prepare(
        'SELECT short_id FROM movies WHERE short_id = ? AND expires_at IS NOT NULL AND datetime(expires_at) < datetime(?)'
      )
      .bind(row.short_id, threshold)
      .all<ShortIdRow>();
    if (current.results.length === 0) continue;

    try {
      await bucket.delete(movieKey(row.short_id));
    } catch {
      // R2 が落ちている間に D1 の行だけ消すと実体が孤児になるため、この行は
      // 飛ばして次回の実行に委ねる（削除は冪等なのでやり直しで問題ない）。
      continue;
    }

    // SELECT 後に期限が延びた動画を巻き込まないよう、削除時にも期限を再確認する。
    const result = await database
      .prepare(
        'DELETE FROM movies WHERE short_id = ? AND expires_at IS NOT NULL AND datetime(expires_at) < datetime(?)'
      )
      .bind(row.short_id, threshold)
      .run();
    deleted += result.meta.changes;
  }

  return deleted;
}

/**
 * commit されないまま放置された pending を回収する。
 *
 * 実体が上がっていれば消してから行を削除する（presign 後にアップロードだけ
 * 成功して commit に到達しなかったケースが R2 に残り続けるのを防ぐ）。
 */
async function deletePendingOrphans(
  database: RetentionDatabase,
  bucket: RetentionBucket,
  now: Date
): Promise<number> {
  const threshold = new Date(now.getTime() - PENDING_ORPHAN_GRACE_MS).toISOString();
  const { results } = await database
    .prepare(
      "SELECT short_id FROM movies WHERE status = 'pending' AND datetime(created_at) < datetime(?)"
    )
    .bind(threshold)
    .all<ShortIdRow>();

  let deleted = 0;
  for (const row of results) {
    const key = movieKey(row.short_id);
    try {
      if (await bucket.head(key)) await bucket.delete(key);
    } catch {
      continue;
    }

    const result = await database
      .prepare("DELETE FROM movies WHERE short_id = ? AND status = 'pending'")
      .bind(row.short_id)
      .run();
    deleted += result.meta.changes;
  }

  return deleted;
}

/** 一定期間を過ぎた failed 行を削除する（実体は commit 時に削除済み）。 */
async function deleteFailedMovies(database: RetentionDatabase, now: Date): Promise<number> {
  const threshold = new Date(now.getTime() - FAILED_RETENTION_MS).toISOString();
  const result = await database
    .prepare("DELETE FROM movies WHERE status = 'failed' AND datetime(created_at) < datetime(?)")
    .bind(threshold)
    .run();

  return result.meta.changes;
}

/**
 * captures/ 配下の古い中間生成物を削除する。
 *
 * list は 1 ページずつ辿り、削除は上限に達した時点で打ち切る。残りは次回の
 * 実行が同じ条件で拾うため、取りこぼしにはならない。
 */
async function deleteStaleCaptures(bucket: RetentionBucket, now: Date): Promise<number> {
  const threshold = now.getTime() - CAPTURE_RETENTION_MS;
  let cursor: string | undefined;
  let deleted = 0;

  while (deleted < MAX_CAPTURE_DELETIONS_PER_RUN) {
    const page: RetentionListResult = await bucket.list(
      cursor === undefined
        ? { prefix: CAPTURE_KEY_PREFIX }
        : { prefix: CAPTURE_KEY_PREFIX, cursor }
    );

    const stale = page.objects
      .filter((object) => object.uploaded.getTime() < threshold)
      .map((object) => object.key)
      .slice(0, MAX_CAPTURE_DELETIONS_PER_RUN - deleted);

    if (stale.length > 0) {
      await bucket.delete(stale);
      deleted += stale.length;
    }

    if (!page.truncated || page.cursor === undefined) break;
    cursor = page.cursor;
  }

  return deleted;
}
