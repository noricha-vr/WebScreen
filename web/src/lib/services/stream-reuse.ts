import { ERROR_CODES, type CreateStreamResponse } from '../contracts/api';
import { isShortId } from '../contracts/r2key';
import { StreamError } from './stream-error';
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
  const result = await input.database
    .prepare(
      `UPDATE stream_sessions
       SET status = 'live', started_at = ?, extend_expires_at = ?, last_heartbeat_at = ?,
           last_viewer_at = ?, ended_at = NULL, end_reason = NULL, kick_pending = 0, start_token = ?
       WHERE id = ? AND user_id = ? AND status = 'ended'
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
    .bind(iso, expiresAt.toISOString(), iso, iso, input.startToken ?? null, id, input.userId,
      input.settings.maxLiveStreams, input.userId, input.settings.maxLiveStreamsPerUser,
      input.userId, rateThreshold, input.startToken ?? null, input.userId, input.startToken ?? null)
    .run();
  if (result.meta.changes === 0) {
    const existing = await input.database
      .prepare('SELECT status FROM stream_sessions WHERE id = ? AND user_id = ?')
      .bind(id, input.userId)
      .first<{ status: 'live' | 'ended' }>();
    if (!existing || existing.status !== 'ended') throw streamIdNotReusableError();
    await rejectCreate();
  }
  return createResponse(id, now, expiresAt, publishToken);
}

function streamIdNotReusableError(): StreamError {
  // 存在・所有・live の別を公開せず、固定 URL として再利用できないことだけを返す。
  return new StreamError(409, ERROR_CODES.streamIdNotReusable, 'この配信 ID は再利用できません');
}

function createResponse(
  id: string,
  now: Date,
  expiresAt: Date,
  publishToken: string
): CreateStreamResponse {
  return {
    id,
    streamUrl: `rtspt://webscreen.tv/live/${id}`,
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
