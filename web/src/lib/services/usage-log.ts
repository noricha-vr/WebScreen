/**
 * 利用ログ（D1 usage_events）。
 *
 * movies の行と R2 の実体は保持期間で消えるため、「誰が・いつ・何を・どれだけ」を
 * 消えない形で残す。1 行 1 出来事の追記専用で、保持期間バッチの対象外。
 * スキーマの正本は migrations/0006_usage_events.sql、集計は make usage-report。
 *
 * 書き込みの失敗は呼び出し元へ投げない。利用ログは製品の操作（commit・削除・ログイン）の
 * 付随物で、ログが書けないことを理由に本体の操作を失敗させると、利用者には理由が見えない
 * まま変換や削除が止まる。代わりに構造化ログへ残し、観測で気づけるようにする。
 */

import { ERROR_CODES } from '../contracts/api';
import { logWorkerFailure } from '../observability/worker-log';

/** 記録する出来事。migrations/0006 の CHECK 制約と一致させること。 */
export const USAGE_EVENTS = [
  'login',
  'movie_ready',
  'movie_deleted',
  'movie_expired',
  'movie_pinned',
  'movie_unpinned',
] as const;

export type UsageEvent = (typeof USAGE_EVENTS)[number];

/** D1 の最小操作面。INSERT しかしない。 */
export interface UsageLogDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}

export interface UsageEventInput {
  userId: number;
  event: UsageEvent;
  /** 動画に紐づく出来事だけ。login では null。 */
  shortId?: string | null;
  /** 変換元の種別（movies.kind）。旧コードで作られた行は null。 */
  kind?: string | null;
  sizeBytes?: number | null;
}

/** 出来事を 1 行追記する。書けなかった時は warn を残して false を返す（例外は投げない）。 */
export async function recordUsageEvent(
  database: UsageLogDatabase,
  input: UsageEventInput
): Promise<boolean> {
  try {
    await database
      .prepare('INSERT INTO usage_events (user_id, event, short_id, kind, size_bytes) VALUES (?, ?, ?, ?, ?)')
      .bind(input.userId, input.event, input.shortId ?? null, input.kind ?? null, input.sizeBytes ?? null)
      .run();
    return true;
  } catch (error) {
    logWorkerFailure({
      level: 'warn',
      event: 'usage_event_write_failed',
      errorCode: ERROR_CODES.internalError,
      status: 500,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return false;
  }
}
