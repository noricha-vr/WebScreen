/**
 * 保持期間バッチ（期限切れ動画・孤児・失敗行の掃除）。
 *
 * captures の掃除（retention-captures.ts）と、実体の無い ready 行の検出
 * （retention-audit.ts）は別モジュールに置き、ここは D1 と R2 をまたぐ movies の
 * 削除だけを持つ。この 3 つをまとめて呼ぶのは runRetention だけ。
 *
 * D1 / R2 はインターフェースで注入し、現在時刻も引数で受け取る（Date.now を呼ぶのは
 * cron の entry 層だけ）。これで workerd なしでも全分岐をテストできる。
 *
 * 実体を消した経路は、続けて公開 URL のキャッシュ purge も投げる（services/cache-purge.ts）。
 * 投げないと削除済みの動画が最大 120 分配信され続ける（docs/r2-delivery.md）。purge の
 * 失敗は掃除を止めない（件数だけ summary に出す。キャッシュは 120 分で自然に切れる）。
 *
 * 行を消す経路は実体を先に消す（R2 → D1）。逆にすると D1 の行を消した時点で R2 の
 * キーを導出できず、実体だけが回収不能になる。署名が関わる pending / failed は行を
 * すぐ消さず、遅延 PUT を次回以降も反復削除できる状態にする。
 *
 * pending には commit という並行の書き手がいるため、R2 に触る前に条件付き UPDATE で
 * pending → failed の「確保」を挟む。commit の UPDATE も status = 'pending' を条件に
 * 持つので、勝つのは必ず一方だけになる。確保した行は failed として残るため、R2 の削除に
 * 失敗しても行は消えず、failed の掃除が同じ順序（R2 → D1）で回収し直せる。
 */

import { movieKey } from '../contracts/r2key';
import { purgeMovieCache, type CachePurgeSettings } from './cache-purge';
import { PINNED_RETENTION_MS } from './quota';
import { auditReadyObjects } from './retention-audit';
import { deleteStaleCaptures, type CaptureBucket } from './retention-captures';
import {
  deleteFailedMovies,
  recordFailedObjectSweep,
  sweepFailedObjects,
} from './retention-failed';
import { recoverPendingUploads } from './retention-pending';

export { MAX_FAILED_DELETIONS_PER_RUN } from './retention-failed';
export { MAX_PENDING_CLAIMS_PER_RUN } from './retention-pending';

/**
 * 1 回の実行で処理する期限切れ動画の行数の上限。1 行あたり最大 4 subrequest
 * （再確認 SELECT / delete / DELETE / 残存確認 SELECT）。残りは次回の実行が拾う。
 */
export const MAX_EXPIRED_DELETIONS_PER_RUN = 50;

/**
 * 各フェーズの最悪ケースの合計を Workers の上限（1 回の実行で 1000 subrequest）より
 * 下に保つ: 期限の補完 1、期限切れ 1 + 50 × 4 = 201、pending 1 + 150 = 151、
 * failed 1 + 1 + 10 = 12、failed 実体の早期回収 1 + 1 + 10 = 12、captures 10 ページ × 2 = 20、
 * 監査 2 + 50 + 50 = 102、キャッシュ purge は経路ごとに 30 URL で 1 回なので
 * ceil(50/30) + ceil(500/30) × 2 = 2 + 34 = 36。合計 535。
 */

/** D1 の最小操作面。バッチが必要とするのは all / run だけ。 */
export interface RetentionDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}

/** R2 の最小操作面。captures の掃除も同じ bucket を使うのでその操作面を含む。 */
export interface RetentionBucket extends CaptureBucket {
  head(key: string): Promise<{ size: number } | null>;
}

/** 1 回の実行で処理した件数。cron の構造化ログにそのまま載せる。 */
export interface RetentionSummary {
  backfilledPinned: number;
  deletedMovies: number;
  /** R2 の実体を消したのに行が残った件数。0 以外は不変条件が破れた印。 */
  strandedMovies: number;
  /** 署名失効後に pending から failed へ確保し、反復 R2 回収へ渡した行数。 */
  recoveredPendingUploads: number;
  deletedFailed: number;
  /** R2 の早期回収対象にした failed のキー数。行を残すため次回以降も対象。 */
  sweptFailedObjects: number;
  /** R2 の削除に失敗して次回の実行へ持ち越した件数。行は残るので取り残しにはならない。 */
  deferredObjectDeletions: number;
  /**
   * 別の書き手が先に更新した等で、この実行では何もしなかった行の件数。
   * 恒久的に失敗するキーを黙って毎時 retry し続けないよう、件数だけは必ず出す。
   */
  skippedRows: number;
  /** どこかの掃除が 1 回の上限に達して打ち切ったか。true なら残りは次回の実行が拾う。 */
  sweepCapped: boolean;
  /** キャッシュ purge を投げた回数（30 URL ごとに 1 回）。 */
  cachePurgeRequests: number;
  /** そのうち失敗した回数。0 以外なら削除済みの動画が最大 120 分配信され続ける。 */
  cachePurgeFailures: number;
  deletedCaptures: number;
  /** 実体の有無を確かめた ready 行のサンプル数（services/retention-audit.ts）。 */
  checkedReadyRows: number;
  /** R2 に実体が無い ready 行の検出数。検出のみで、削除は行わない。 */
  missingObjectRows: number;
  /** 監査の head が失敗した件数。0 以外は監査自体が機能していない印。 */
  auditErrors: number;
}

export interface RetentionInput {
  database: RetentionDatabase;
  bucket: RetentionBucket;
  /** バッチの基準時刻。cron の scheduledTime を渡す。 */
  now: Date;
  /** 削除した動画の公開 URL をキャッシュから落とすための設定（cron の entry が組む）。 */
  cachePurge: CachePurgeSettings;
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
  const { database, bucket, now, cachePurge } = input;

  // 掃除より先に走らせる。期限を入れた直後の行は 1 年先なので同じ実行では消えない。
  const backfilledPinned = await backfillPinnedExpiry(database, now);
  // 経路ごとに、実体を消した直後にキャッシュも落とす（最後にまとめると、後続の掃除が
  // 落ちた時に先行の分まで purge されず「消したのに 120 分見える」が残る）。
  const expired = await deleteExpiredMovies(database, bucket, now);
  const expiredPurge = await purgeMovieCache(expired.purged, cachePurge);
  const failed = await deleteFailedMovies(database, bucket, now);
  const failedPurge = await purgeMovieCache(failed.purged, cachePurge);
  // 24時間超の pending をこの実行で failed にしても、墓石を即消さない。
  // 次の failed object sweep が実体を回収し、行は次サイクルの failed purge まで残す。
  const pending = await recoverPendingUploads(database, now);
  const failedObjects = await sweepFailedObjects(database, bucket, now, pending.recoveredShortIds);
  const failedObjectsPurge = await purgeMovieCache(failedObjects.purged, cachePurge);
  // purge の成否にかかわらず試行後に記録する。R2 delete 失敗時は purged が空なので更新しない。
  await recordFailedObjectSweep(database, failedObjects.purged, now);
  const captures = await deleteStaleCaptures(bucket, now);
  // 掃除の後に見る（この実行で消した行を実体なしと数えないため）。何も削除しない。
  const audit = await auditReadyObjects(database, bucket);

  return {
    backfilledPinned,
    deletedMovies: expired.deleted,
    strandedMovies: expired.stranded,
    recoveredPendingUploads: pending.recovered,
    deletedFailed: failed.deleted,
    sweptFailedObjects: failedObjects.swept,
    deferredObjectDeletions: expired.deferred + failed.deferred + failedObjects.deferred,
    skippedRows: expired.skipped + pending.skipped,
    sweepCapped:
      expired.capped || pending.capped || failed.capped || failedObjects.capped || captures.capped,
    cachePurgeRequests:
      expiredPurge.requests +
      failedPurge.requests +
      failedObjectsPurge.requests,
    cachePurgeFailures:
      expiredPurge.failures +
      failedPurge.failures +
      failedObjectsPurge.failures,
    deletedCaptures: captures.deleted,
    checkedReadyRows: audit.checkedReadyRows,
    missingObjectRows: audit.missingObjectRows,
    auditErrors: audit.auditErrors,
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
): Promise<{
  deleted: number;
  stranded: number;
  skipped: number;
  deferred: number;
  /** R2 の実体を消した shortId（行が残ったものも含む。キャッシュは落とす）。 */
  purged: string[];
  capped: boolean;
}> {
  const threshold = now.toISOString();
  const { results } = await database
    .prepare(
      "SELECT short_id FROM movies WHERE status = 'ready' AND expires_at IS NOT NULL AND datetime(expires_at) < datetime(?) LIMIT ?"
    )
    .bind(threshold, MAX_EXPIRED_DELETIONS_PER_RUN)
    .all<ShortIdRow>();

  let deleted = 0;
  let stranded = 0;
  let skipped = 0;
  let deferred = 0;
  const purged: string[] = [];
  for (const row of results) {
    // 初回 SELECT の後に pin（= 期限の延長）が入った場合、R2 を先に消すと生きた
    // 行だけが残る。R2 削除の直前にも期限を読み直し、実体と行の不整合を防ぐ。
    const current = await database
      .prepare(
        "SELECT short_id FROM movies WHERE short_id = ? AND status = 'ready' AND expires_at IS NOT NULL AND datetime(expires_at) < datetime(?)"
      )
      .bind(row.short_id, threshold)
      .all<ShortIdRow>();
    if (current.results.length === 0) {
      // 期限が延びた・既に消えた（正常な競合）。件数だけ残して次へ。
      skipped += 1;
      continue;
    }

    try {
      await bucket.delete(movieKey(row.short_id));
    } catch {
      // R2 が落ちている間に D1 の行だけ消すと実体が孤児になるため、この行は
      // 飛ばして次回の実行に委ねる（削除は冪等なのでやり直しで問題ない）。
      deferred += 1;
      continue;
    }
    purged.push(row.short_id);

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

  return {
    deleted,
    stranded,
    skipped,
    deferred,
    purged,
    capped: results.length === MAX_EXPIRED_DELETIONS_PER_RUN,
  };
}
