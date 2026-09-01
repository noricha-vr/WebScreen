/** 配信セッションの状態。D1 の CHECK 制約と一致させる。 */
export const STREAM_SESSION_STATUSES = ['live', 'ended'] as const;
export type StreamSessionStatus = (typeof STREAM_SESSION_STATUSES)[number];

/** 配信が終了した理由。D1 の CHECK 制約と一致させる。 */
export const STREAM_END_REASONS = [
  'extend_timeout',
  'no_viewers',
  'heartbeat_lost',
  'user_stop',
] as const;
export type StreamEndReason = (typeof STREAM_END_REASONS)[number];

/** 配信セッションの所有者向け状態。時刻はすべて ISO8601。 */
export interface StreamStatusResponse {
  id: string;
  streamUrl: string;
  status: StreamSessionStatus;
  startedAt: string;
  extendExpiresAt: string;
  lastHeartbeatAt: string;
  endedAt: string | null;
  endReason: StreamEndReason | null;
}

/** `POST /api/streams/` の応答。 */
export interface CreateStreamResponse extends StreamStatusResponse {
  publishToken: string;
  publishTokenExpiresAt: string;
}

/** `POST /api/streams/{id}/extend/` の応答。 */
export interface ExtendStreamResponse {
  id: string;
  status: 'live';
  publishToken: string;
  publishTokenExpiresAt: string;
  extendExpiresAt: string;
}
