/**
 * 保持期間バッチの監査（R2 に実体が無い ready 行の検出）。
 *
 * 掃除（retention.ts）とは責務が別で、ここは何も消さない。片方だけが更新された
 * 痕跡を数えて cron のログに出すだけにする。行の削除は不可逆で、「実体が無い」の
 * 判定を誤ると再生できる動画を消してしまうため、回復は人の判断に残す。
 */

import { movieKey } from '../contracts/r2key';

/**
 * 1 回の実行で実体の有無を確かめる ready 行の上限。1 行につき head を 1 回使う。
 * 掃除側は pending の確保だけで最大 800 subrequest を使うため、Workers の上限
 * （1 回あたり 1000）に収まるよう小さく取る。残りは次回以降の実行が拾う。
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
  /** R2 の一時失敗で判断できず、次回に委ねた行の数。 */
  skippedRows: number;
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
 * 毎回ランダムに選ぶのは、先頭から固定数を見ると同じ行だけを見続けて残りに永久に
 * 届かないため。1 回では取りこぼすが、毎時の実行を重ねれば行き渡る（カーソルのような
 * 状態をどこにも持たずに済む）。
 */
export async function auditReadyObjects(
  database: AuditDatabase,
  bucket: AuditBucket
): Promise<ReadyObjectAudit> {
  const { results } = await database
    .prepare("SELECT short_id FROM movies WHERE status = 'ready' ORDER BY RANDOM() LIMIT ?")
    .bind(MAX_OBJECT_CHECKS_PER_RUN)
    .all<ShortIdRow>();

  let checkedReadyRows = 0;
  let missingObjectRows = 0;
  let skippedRows = 0;

  for (const row of results) {
    let object: { size: number } | null;
    try {
      object = await bucket.head(movieKey(row.short_id));
    } catch {
      // R2 の一時失敗を「実体が無い」と読むと誤検知になる。判断は次回に委ねる。
      skippedRows += 1;
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

  return { checkedReadyRows, missingObjectRows, skippedRows };
}
