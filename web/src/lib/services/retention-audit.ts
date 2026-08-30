/**
 * 保持期間バッチの監査（R2 に実体が無い ready 行の検出）。
 *
 * 掃除（retention.ts）とは責務が別で、ここは何も消さない。片方だけが更新された
 * 痕跡を数えて cron のログに出すだけにする。行の削除は不可逆で、「実体が無い」の
 * 判定を誤ると再生できる動画を消してしまうため、回復は人の判断に残す。
 */

import { generateShortId, movieKey } from '../contracts/r2key';

/**
 * 1 回の実行で実体の有無を確かめる ready 行の上限。1 行につき head を 1 回、
 * 実体が無かった行だけ再確認の SELECT を 1 回使う（最悪 2 + 50 + 50 = 102）。
 * 掃除側の最悪ケース（合計 685。内訳は services/retention.ts の
 * MAX_PENDING_CLAIMS_PER_RUN のコメント）と足しても Workers の上限
 * （1 回あたり 1000）に収まる値にしている。残りは次回以降の実行が拾う。
 */
export const MAX_OBJECT_CHECKS_PER_RUN = 50;

/** 監査が使う D1 の最小操作面（読み取りのみ）。 */
export interface AuditDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
    };
  };
}

/** 監査が使う R2 の最小操作面（存在確認のみ）。 */
export interface AuditBucket {
  head(key: string): Promise<{ size: number } | null>;
}

export interface ReadyObjectAudit {
  /** 実体の有無を確かめられた ready 行の数（サンプル数）。 */
  checkedReadyRows: number;
  /** 実体が見つからなかった ready 行の数。0 以外は不変条件が破れた印。 */
  missingObjectRows: number;
  /**
   * R2 の head に失敗して判断できなかった行の数。監査そのものが機能していない印なので、
   * 正常な競合によるスキップとは別に数えて cron のログで警告する。
   */
  auditErrors: number;
}

interface ShortIdRow {
  short_id: string;
}

/**
 * ready 行を抜き取り、R2 に実体があるかを確かめる（検出のみ・削除しない）。
 *
 * ready は commit が head で実体を確認してから付ける状態なので、実体の無い ready 行は
 * 削除の片落ち（services/movies.ts の deleteMovie）でしか生まれない。
 *
 * 抜き取りは「ランダムな開始点からの主キーの範囲走査」で行う。ORDER BY RANDOM() は
 * ready 行を全件読んで並べ替えるため、行が増えるほど 1 回の実行が重くなる。short_id は
 * 主キー（base62 12 文字）なので、同じ形式の値を毎回作って開始点にすれば、走査は
 * LIMIT 件で止まりつつ実行のたびに違う範囲を見られる。
 */
export async function auditReadyObjects(
  database: AuditDatabase,
  bucket: AuditBucket,
  generateStartId: () => string = generateShortId
): Promise<ReadyObjectAudit> {
  const results = await sampleReadyRows(database, generateStartId());

  let checkedReadyRows = 0;
  let missingObjectRows = 0;
  let auditErrors = 0;

  for (const row of results) {
    let object: { size: number } | null;
    try {
      object = await bucket.head(movieKey(row.short_id));
    } catch {
      // R2 の一時失敗を「実体が無い」と読むと誤検知になる。判断は次回に委ねる。
      auditErrors += 1;
      continue;
    }

    checkedReadyRows += 1;
    if (object) continue;

    // 所有者の削除は R2 → D1 の順なので、その隙間を見ただけかもしれない。
    // 行がまだ ready で残っている時だけ不整合として数える。
    const remaining = await database
      .prepare("SELECT short_id FROM movies WHERE short_id = ? AND status = 'ready'")
      .bind(row.short_id)
      .all<ShortIdRow>();
    if (remaining.results.length > 0) missingObjectRows += 1;
  }

  return { checkedReadyRows, missingObjectRows, auditErrors };
}

/**
 * 開始点以降の ready 行を LIMIT 件だけ読む。0 件なら先頭から取り直す（ラップ）。
 *
 * 開始点が既存の short_id より後ろに寄ると空になるため、回り込みが無いと末尾付近を
 * 引いた実行が毎回何も見ないまま終わる。
 */
async function sampleReadyRows(database: AuditDatabase, startId: string): Promise<ShortIdRow[]> {
  const page = await selectReadyRowsFrom(database, startId);
  if (page.length > 0) return page;
  return selectReadyRowsFrom(database, '');
}

async function selectReadyRowsFrom(
  database: AuditDatabase,
  startId: string
): Promise<ShortIdRow[]> {
  const { results } = await database
    .prepare(
      "SELECT short_id FROM movies WHERE status = 'ready' AND short_id >= ? ORDER BY short_id LIMIT ?"
    )
    .bind(startId, MAX_OBJECT_CHECKS_PER_RUN)
    .all<ShortIdRow>();
  return results;
}
