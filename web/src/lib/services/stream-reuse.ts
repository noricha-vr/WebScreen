import { ERROR_CODES, type CreateStreamResponse } from '../contracts/api';
import { isShortId } from '../contracts/r2key';
import { StreamError } from './stream-error';
import { throwIfExistingStartToken } from './stream-start';
import type { StreamServiceInput } from './streams';

/** 終了済みかつ所有する path ID を、通常作成と同じ制約で live に戻す。 */
export async function reuseStream(
  input: StreamServiceInput,
  id: string,
  now: Date,
  expiresAt: Date,
  rateThreshold: string,
  rejectCreate: () => Promise<never>
): Promise<CreateStreamResponse> {
  if (!isShortId(id)) {
    throw new StreamError(400, ERROR_CODES.invalidRequest, '配信 ID の形式が不正です');
  }
  const iso = now.toISOString();
  // JWT 発行失敗後に live 行だけ残さないため、条件付き更新より先に署名する。
  const publishToken = await input.signPublishToken({
    pathId: id,
    issuedAtSeconds: Math.floor(now.getTime() / 1000),
    expiresAtSeconds: Math.floor(expiresAt.getTime() / 1000),
  });
  let result: { meta: { changes: number } };
  try {
    result = await input.database
      .prepare(
        `UPDATE stream_sessions
       SET status = 'live', started_at = ?, extend_expires_at = ?, last_heartbeat_at = ?,
           last_viewer_at = ?, ended_at = NULL, end_reason = NULL, start_token = ?
       WHERE id = ? AND user_id = ? AND status = 'ended'
       -- Publish JWTs contain only path and exp, so an old publisher cannot be distinguished by JWKS.
       -- Keep this path unavailable until its old JWT expires and the prior kick has completed.
       AND kick_pending = 0 AND extend_expires_at <= ?
       AND (SELECT COUNT(*) FROM stream_sessions WHERE status = 'live') < ?
       AND (SELECT COUNT(*) FROM stream_sessions WHERE user_id = ? AND status = 'live') < ?
       AND NOT EXISTS (
         SELECT 1 FROM stream_sessions WHERE user_id = ? AND started_at > ?
       )
       AND (? IS NULL OR NOT EXISTS (
         SELECT 1 FROM stream_start_cancellations
         WHERE user_id = ? AND start_token = ?
       ))`
      )
      .bind(
        iso,
        expiresAt.toISOString(),
        iso,
        iso,
        input.startToken ?? null,
        id,
        input.userId,
        iso,
        input.settings.maxLiveStreams,
        input.userId,
        input.settings.maxLiveStreamsPerUser,
        input.userId,
        rateThreshold,
        input.startToken ?? null,
        input.userId,
        input.startToken ?? null
      )
      .run();
  } catch (error) {
    // UNIQUE(user_id, start_token) can collide with a separate ended session during reuse.
    if (input.startToken) await throwIfExistingStartToken(input.database, input.userId, input.startToken);
    throw error;
  }
  if (result.meta.changes === 0) {
    const existing = await input.database
      .prepare('SELECT status, kick_pending, extend_expires_at FROM stream_sessions WHERE id = ? AND user_id = ?')
      .bind(id, input.userId)
      .first<{ status: 'live' | 'ended'; kick_pending: 0 | 1; extend_expires_at: string }>();
    if (!existing || existing.status !== 'ended') throw streamIdNotReusableError();
    if (existing.kick_pending !== 0) throw streamIdNotReusableError();
    const retryAfterSeconds = secondsUntil(existing.extend_expires_at, now);
    if (retryAfterSeconds > 0) throw streamIdNotReusableError(retryAfterSeconds);
    await rejectCreate();
  }
  return createResponse(id, now, expiresAt, publishToken, input.settings.whipOrigin);
}

function streamIdNotReusableError(retryAfterSeconds?: number): StreamError {
  // 存在・所有・live の別を公開せず、固定 URL として再利用できないことだけを返す。
  return new StreamError(
    409,
    ERROR_CODES.streamIdNotReusable,
    'この配信 ID は再利用できません',
    retryAfterSeconds === undefined ? {} : { retryAfterSeconds }
  );
}

function secondsUntil(expiresAt: string, now: Date): number {
  const milliseconds = Date.parse(expiresAt) - now.getTime();
  return Number.isFinite(milliseconds) ? Math.max(0, Math.ceil(milliseconds / 1000)) : 0;
}

function createResponse(
  id: string,
  now: Date,
  expiresAt: Date,
  publishToken: string,
  whipOrigin: string
): CreateStreamResponse {
  return {
    id,
    streamUrl: `rtspt://webscreen.tv/live/${id}`,
    whipUrl: `${whipOrigin}/live/${encodeURIComponent(id)}/whip`,
    publishToken,
    publishTokenExpiresAt: expiresAt.toISOString(),
    extendExpiresAt: expiresAt.toISOString(),
    status: 'live',
    startedAt: now.toISOString(),
    lastHeartbeatAt: now.toISOString(),
    endedAt: null,
    endReason: null,
  };
}
