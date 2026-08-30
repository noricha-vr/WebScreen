/**
 * 保持期間バッチ（期限切れ動画・孤児・失敗行・キャプチャの掃除）。
 *
 * D1 / R2 はインターフェースで注入し、現在時刻も引数で受け取る（Date.now を呼ぶのは
 * cron の entry 層だけ）。これで workerd なしでも全分岐をテストできる。
 *
 * 実体を消してから行を消す（R2 → D1）。逆にすると D1 の行を消した時点で R2 のキーを
 * 導出できなくなり、実体だけが残って回収不能になる（R2 の delete は存在しないキーでも
 * 成功するため、この順序なら途中失敗しても次回実行でやり直せる）。
 *
 * pending には commit という並行の書き手がいるため、R2 に触る前に条件付き UPDATE で
 * pending → failed の「確保」を挟む。commit の UPDATE も status = 'pending' を条件に
 * 持つので、勝つのは必ず一方だけになる。確保した行は failed として残るため、R2 の削除に
 * 失敗しても行は消えず、failed の掃除が同じ順序（R2 → D1）で回収し直せる。
 */

import { movieKey } from '../contracts/r2key';
import { PINNED_RETENTION_MS } from './quota';

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

/**
 * 1 回の実行で処理する movies の行数の上限（pending の回収と failed の掃除で共通）。
 * failed は容量計算の対象外なので行数は利用者側から無制限に増やせる。上限を置かないと
 * D1 のクエリ数と Workers の subrequest を使い切って実行ごと落ちる。残りは次回が拾う。
 */
export const MAX_MOVIE_DELETIONS_PER_RUN = 500;

/** 1 文の DELETE に載せる short_id の数。D1 のバインド変数の上限（100）に収める。 */
const MAX_IDS_PER_DELETE = 50;

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

/** 1 回の実行で処理した件数。cron の構造化ログにそのまま載せる。 */
export interface RetentionSummary {
  backfilledPinned: number;
  deletedMovies: number;
  /** R2 の実体を消したのに行が残った件数。0 以外は不変条件が破れた印。 */
  strandedMovies: number;
  deletedOrphans: number;
  deletedFailed: number;
  /** R2 の削除に失敗して次回の実行へ持ち越した件数。行は残るので取り残しにはならない。 */
  deferredObjectDeletions: number;
  /** movies の掃除が 1 回の上限に達して打ち切ったか。true なら残りは次回の実行が拾う。 */
  sweepCapped: boolean;
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

  // 掃除より先に走らせる。期限を入れた直後の行は 1 年先なので同じ実行では消えない。
  const backfilledPinned = await backfillPinnedExpiry(database, now);
  const expired = await deleteExpiredMovies(database, bucket, now);
  const orphans = await deletePendingOrphans(database, bucket, now);
  // 孤児の確保で R2 の削除に失敗した行も failed として残っているため、同じ実行の
  // ここで拾い直せる（猶予はどちらも 24 時間）。取りこぼしても次回の実行が同じ条件で拾う。
  const failed = await deleteFailedMovies(database, bucket, now);

  return {
    backfilledPinned,
    deletedMovies: expired.deleted,
    strandedMovies: expired.stranded,
    deletedOrphans: orphans.deleted,
    deletedFailed: failed.deleted,
    deferredObjectDeletions: failed.deferred,
    sweepCapped: orphans.capped || failed.capped,
    deletedCaptures: await deleteStaleCaptures(bucket, now),
  };
}

/**
 * pin 済みなのに期限を持たない行へ、1 年後の期限を入れる。
 *
 * 保管期間を有限にする前の行（pin で expires_at を NULL にしていた頃のもの）と、
 * デプロイの切り替え中に旧コードが書いた行が対象。掃除は expires_at でしか
 * 判定しないため、NULL のまま残ると永久に対象外になる。毎時の実行で何度通っても
 * 同じ結果になる形にして、取りこぼしを次の実行が拾えるようにする。
 */
async function backfillPinnedExpiry(database: RetentionDatabase, now: Date): Promise<number> {
  const expiresAt = new Date(now.getTime() + PINNED_RETENTION_MS).toISOString();
  const result = await database
    .prepare('UPDATE movies SET expires_at = ? WHERE pinned = 1 AND expires_at IS NULL')
    .bind(expiresAt)
    .run();

  return result.meta.changes;
}

/**
 * expires_at を過ぎた ready 動画を削除する。pin の有無では絞らない
 * （pin は保管期間を 365 日へ延ばすだけで、期限が来れば同じように消える）。
 *
 * R2 と D1 をまたぐ削除は原子的にできないので、「期限切れは終端の状態である」ことに
 * 依存している。期限を延ばせるのは services/movies.ts の togglePin だけで、そこが
 * 期限切れの行を 410 で断るため、SELECT から DELETE までの間に期限が延びることはない。
 * それでも行が残った場合は stranded として数え、cron のログに出す（Fail Loud）。
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
): Promise<{ deleted: number; stranded: number }> {
  const threshold = now.toISOString();
  const { results } = await database
    .prepare(
      "SELECT short_id FROM movies WHERE status = 'ready' AND expires_at IS NOT NULL AND datetime(expires_at) < datetime(?)"
    )
    .bind(threshold)
    .all<ShortIdRow>();

  let deleted = 0;
  let stranded = 0;
  for (const row of results) {
    // 初回 SELECT の後に pin（= 期限の延長）が入った場合、R2 を先に消すと生きた
    // 行だけが残る。R2 削除の直前にも期限を読み直し、実体と行の不整合を防ぐ。
    const current = await database
      .prepare(
        "SELECT short_id FROM movies WHERE short_id = ? AND status = 'ready' AND expires_at IS NOT NULL AND datetime(expires_at) < datetime(?)"
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
        "DELETE FROM movies WHERE short_id = ? AND status = 'ready' AND expires_at IS NOT NULL AND datetime(expires_at) < datetime(?)"
      )
      .bind(row.short_id, threshold)
      .run();
    deleted += result.meta.changes;
    // 0 件は「行が残った」とは限らない（所有者の削除と競合しただけなら正常）。
    // 実体を消したのに行が残っている時だけ、不変条件が破れた印として数える。
    // 次回の実行では R2 が空で気づけないため、この場で確かめる。
    if (result.meta.changes === 0) {
      const remaining = await database
        .prepare('SELECT short_id FROM movies WHERE short_id = ?')
        .bind(row.short_id)
        .all<ShortIdRow>();
      if (remaining.results.length > 0) stranded += 1;
    }
  }

  return { deleted, stranded };
}

/**
 * commit されないまま放置された pending を回収する。
 *
 * R2 に触る前に、条件付き UPDATE で pending → failed の確保を行う。同時に走る commit の
 * UPDATE も status = 'pending' を条件に持つため、勝つのは必ずどちらか一方だけになる。
 * 負けた側（= 0 件）は実体が ready の行のものなので R2 に触らない。
 *
 * 行を消すのは R2 の削除に成功した後だけ。失敗した行は failed のまま残り、
 * failed の掃除（deleteFailedMovies）が同じ順序で回収し直す。
 */
async function deletePendingOrphans(
  database: RetentionDatabase,
  bucket: RetentionBucket,
  now: Date
): Promise<{ deleted: number; capped: boolean }> {
  const threshold = new Date(now.getTime() - PENDING_ORPHAN_GRACE_MS).toISOString();
  const { results } = await database
    .prepare(
      "SELECT short_id FROM movies WHERE status = 'pending' AND datetime(created_at) < datetime(?) LIMIT ?"
    )
    .bind(threshold, MAX_MOVIE_DELETIONS_PER_RUN)
    .all<ShortIdRow>();

  let deleted = 0;
  for (const row of results) {
    // SELECT 後に commit が確定した行を巻き込まないよう、確保時にも猶予を再確認する。
    const claim = await database
      .prepare(
        "UPDATE movies SET status = 'failed' WHERE short_id = ? AND status = 'pending' AND datetime(created_at) < datetime(?)"
      )
      .bind(row.short_id, threshold)
      .run();
    if (claim.meta.changes === 0) continue;

    // 削除に失敗した行は failed のまま残す（件数は failed の掃除が数える）。
    if (!(await deleteMovieObject(bucket, row.short_id))) continue;

    const result = await database
      .prepare("DELETE FROM movies WHERE short_id = ? AND status = 'failed'")
      .bind(row.short_id)
      .run();
    deleted += result.meta.changes;
  }

  return { deleted, capped: results.length === MAX_MOVIE_DELETIONS_PER_RUN };
}

/**
 * 動画の実体を R2 から消す。成功（元から無い場合を含む）で true を返す。
 *
 * R2 が落ちている間に D1 の行だけ消すと実体が孤児になるため、呼び出し側は false の時に
 * 行を残し、次回の実行へ持ち越す。
 */
async function deleteMovieObject(bucket: RetentionBucket, shortId: string): Promise<boolean> {
  const key = movieKey(shortId);
  try {
    if (await bucket.head(key)) await bucket.delete(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一定期間を過ぎた failed 行を削除する。
 *
 * 通常の failed（commit の上限超過）は実体が削除済みだが、pending の確保で R2 の削除に
 * 失敗した行もここへ来る。存在しないキーの delete は成功するので head で確認せず、
 * まとめて delete してから行を消す（R2 → D1 の順は維持する）。R2 が落ちていれば
 * 行を残したまま次回へ持ち越す。
 */
async function deleteFailedMovies(
  database: RetentionDatabase,
  bucket: RetentionBucket,
  now: Date
): Promise<{ deleted: number; deferred: number; capped: boolean }> {
  const threshold = new Date(now.getTime() - FAILED_RETENTION_MS).toISOString();
  const { results } = await database
    .prepare(
      "SELECT short_id FROM movies WHERE status = 'failed' AND datetime(created_at) < datetime(?) LIMIT ?"
    )
    .bind(threshold, MAX_MOVIE_DELETIONS_PER_RUN)
    .all<ShortIdRow>();

  const capped = results.length === MAX_MOVIE_DELETIONS_PER_RUN;
  if (results.length === 0) return { deleted: 0, deferred: 0, capped };

  const shortIds = results.map((row) => row.short_id);
  try {
    await bucket.delete(shortIds.map(movieKey));
  } catch {
    // R2 が落ちている間に行だけ消すと実体が孤児になるため、この実行では行を残す。
    return { deleted: 0, deferred: shortIds.length, capped };
  }

  let deleted = 0;
  for (let index = 0; index < shortIds.length; index += MAX_IDS_PER_DELETE) {
    const chunk = shortIds.slice(index, index + MAX_IDS_PER_DELETE);
    const placeholders = chunk.map(() => '?').join(', ');
    const result = await database
      .prepare(`DELETE FROM movies WHERE status = 'failed' AND short_id IN (${placeholders})`)
      .bind(...chunk)
      .run();
    deleted += result.meta.changes;
  }

  return { deleted, deferred: 0, capped };
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
