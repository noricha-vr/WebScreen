import { ERROR_CODES } from '../contracts/api';
import { StreamError } from './stream-error';
import type { StreamDatabase } from './streams';

/** 各利用者について保持する開始キャンセルtombstoneの上限。 */
export const MAX_STREAM_START_CANCELLATIONS_PER_USER = 32;
const OTHER_START_CANCELLATIONS_TO_KEEP = MAX_STREAM_START_CANCELLATIONS_PER_USER - 1;

/** 開始 token をtombstone化し、履歴制限とmatching live停止を1 batchで適用する。 */
export async function cancelStreamStart(input: {
  database: StreamDatabase;
  userId: number;
  startToken: string;
  now?: Date;
}): Promise<void> {
  const cancelledAt = (input.now ?? new Date()).toISOString();
  const tombstone = input.database
    .prepare(
      `INSERT INTO stream_start_cancellations (user_id, start_token, cancelled_at)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, start_token) DO NOTHING`
    )
    .bind(input.userId, input.startToken, cancelledAt);
  const prune = input.database
    .prepare(
      `DELETE FROM stream_start_cancellations
       WHERE user_id = ? AND start_token <> ? AND start_token NOT IN (
         SELECT start_token FROM stream_start_cancellations
         WHERE user_id = ? AND start_token <> ?
         ORDER BY cancelled_at DESC, start_token DESC
         LIMIT ?
       )`
    )
    .bind(
      input.userId,
      input.startToken,
      input.userId,
      input.startToken,
      OTHER_START_CANCELLATIONS_TO_KEEP
    );
  const stopMatching = input.database
    .prepare(
      `UPDATE stream_sessions
       SET status = 'ended', ended_at = ?, end_reason = 'user_stop', kick_pending = 1
       WHERE user_id = ? AND start_token = ? AND status = 'live'`
    )
    .bind(cancelledAt, input.userId, input.startToken);
  await input.database.batch([tombstone, prune, stopMatching]);
}

/** 同じ利用者・開始tokenですでに確定したsessionの状態を返す。 */
export async function existingStreamStartStatus(
  database: StreamDatabase,
  userId: number,
  startToken: string
): Promise<'live' | 'ended' | null> {
  const existing = await database
    .prepare('SELECT status FROM stream_sessions WHERE user_id = ? AND start_token = ?')
    .bind(userId, startToken)
    .first<{ status: 'live' | 'ended' }>();
  return existing?.status ?? null;
}

/** 同じ開始 token の確定済み session を、通常作成と同じ 409 へ変換する。 */
export async function throwIfExistingStartToken(
  database: StreamDatabase,
  userId: number,
  startToken: string
): Promise<void> {
  const status = await existingStreamStartStatus(database, userId, startToken);
  if (status === 'live') {
    throw new StreamError(409, ERROR_CODES.streamAlreadyLive, '既に配信中です');
  }
  if (status === 'ended') {
    throw new StreamError(409, ERROR_CODES.streamEnded, '終了した配信は更新できません');
  }
}
