import {
  ERROR_CODES,
  type CreateStreamResponse,
  type ExtendStreamResponse,
  type StopLiveStreamsResponse,
  type StreamEndReason,
  type StreamStatusResponse,
} from '../contracts/api';
import { generateShortId } from '../contracts/r2key';
import { throwIfExistingStartToken } from './stream-start';
import { StreamError } from './stream-error';
import { reuseStream } from './stream-reuse';
export { StreamError } from './stream-error';
// 配信ホスト名は allowlist に焼き込まれるため凍結（2026-09-01 webscreen.tv に確定。docs/streaming/requirements.md）
const STREAM_BASE_URL = 'rtspt://webscreen.tv/live';
const DEFAULT_CREATE_RETRIES = 4;
export interface StreamDatabase {
  prepare(query: string): { bind(...values: unknown[]): StreamDatabaseStatement };
  batch(statements: StreamDatabaseStatement[]): Promise<Array<{ meta: { changes: number } }>>;
}
export interface StreamDatabaseStatement {
  first<T>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface StreamSettings {
  extensionCycleSeconds: number;
  extensionEnabled: boolean;
  maxLiveStreamsPerUser: number;
  maxLiveStreams: number;
  createIntervalSeconds: number;
}
export interface StreamJwtSignInput {
  pathId: string;
  issuedAtSeconds: number;
  expiresAtSeconds: number;
}
export type StreamJwtSigner = (input: StreamJwtSignInput) => Promise<string>;
interface StreamRow {
  id: string;
  user_id: number;
  status: 'live' | 'ended';
  started_at: string;
  extend_expires_at: string;
  last_heartbeat_at: string;
  ended_at: string | null;
  end_reason: StreamEndReason | null;
}
export interface StreamServiceInput {
  database: StreamDatabase;
  userId: number;
  settings: StreamSettings;
  signPublishToken: StreamJwtSigner;
  now?: Date;
  generateId?: () => string;
  startToken?: string | null;
  reuseId?: string;
}
/** 新しい path ID を予約し、延長期限と同じ exp の publish JWT を返す。 */
export async function createStream(input: StreamServiceInput): Promise<CreateStreamResponse> {
  const now = truncateToSeconds(input.now ?? new Date());
  const expiresAt = addSeconds(now, input.settings.extensionCycleSeconds);
  const rateThreshold = addSeconds(now, -input.settings.createIntervalSeconds).toISOString();

  if (input.reuseId) {
    return reuseStream(input, input.reuseId, now, expiresAt, rateThreshold, () =>
      throwCreateRejection(input.database, input.userId, rateThreshold, input.settings, input.startToken)
    );
  }

  for (let attempt = 0; attempt < DEFAULT_CREATE_RETRIES; attempt += 1) {
    const id = (input.generateId ?? generateShortId)();
    const publishToken = await input.signPublishToken({
      pathId: id,
      issuedAtSeconds: toNumericDate(now),
      expiresAtSeconds: toNumericDate(expiresAt),
    });
    try {
      const inserted = await insertStream(input, id, now, expiresAt, rateThreshold);
      if (inserted) return createResponse(id, now, expiresAt, publishToken);
    } catch (error) {
      if (await streamIdExists(input.database, id)) continue;
      if (input.startToken) {
        await throwIfExistingStartToken(input.database, input.userId, input.startToken);
      }
      throw error;
    }
    await throwCreateRejection(
      input.database,
      input.userId,
      rateThreshold,
      input.settings,
      input.startToken
    );
  }
  throw new Error('Unable to allocate a unique stream path ID');
}

/** live セッションだけを延長し、新期限と同じ exp の JWT を返す。 */
export async function extendStream(
  input: StreamServiceInput & { id: string }
): Promise<ExtendStreamResponse> {
  const current = await requireOwnedStream(input.database, input.userId, input.id);
  if (current.status === 'ended') throw endedError();
  // JWT の発行前に拒否し、無効期間に期限・publish token を更新しない。
  if (!input.settings.extensionEnabled) {
    throw new StreamError(409, ERROR_CODES.streamExtensionDisabled, 'このベータ版では延長できません');
  }

  const now = truncateToSeconds(input.now ?? new Date());
  if (current.extend_expires_at <= now.toISOString()) throw endedError();
  const expiresAt = addSeconds(now, input.settings.extensionCycleSeconds);
  const publishToken = await input.signPublishToken({
    pathId: input.id,
    issuedAtSeconds: toNumericDate(now),
    expiresAtSeconds: toNumericDate(expiresAt),
  });
  const result = await input.database
    .prepare(
      `UPDATE stream_sessions SET extend_expires_at = ?
       WHERE id = ? AND user_id = ? AND status = 'live' AND extend_expires_at > ?`
    )
    .bind(expiresAt.toISOString(), input.id, input.userId, now.toISOString())
    .run();
  if (result.meta.changes === 0) {
    const latest = await requireOwnedStream(input.database, input.userId, input.id);
    if (latest.status === 'ended') throw endedError();
    throw new Error('Stream extension update was not applied');
  }

  return {
    id: input.id,
    status: 'live',
    publishToken,
    publishTokenExpiresAt: expiresAt.toISOString(),
    extendExpiresAt: expiresAt.toISOString(),
  };
}

/** 所有する live セッションの heartbeat 時刻を更新する。 */
export async function heartbeatStream(input: {
  database: StreamDatabase;
  userId: number;
  id: string;
  now?: Date;
}): Promise<void> {
  const result = await input.database
    .prepare(
      `UPDATE stream_sessions SET last_heartbeat_at = ?
       WHERE id = ? AND user_id = ? AND status = 'live'`
    )
    .bind((input.now ?? new Date()).toISOString(), input.id, input.userId)
    .run();
  if (result.meta.changes > 0) return;
  const current = await requireOwnedStream(input.database, input.userId, input.id);
  if (current.status === 'ended') throw endedError();
}

/** 所有するセッションを user_stop で終了する。既に ended なら成功する。 */
export async function stopStream(input: {
  database: StreamDatabase;
  userId: number;
  id: string;
  now?: Date;
}): Promise<void> {
  const result = await input.database
    .prepare(
      `UPDATE stream_sessions
       SET status = 'ended', ended_at = ?, end_reason = 'user_stop', kick_pending = 1
       WHERE id = ? AND user_id = ? AND status = 'live'`
    )
    .bind((input.now ?? new Date()).toISOString(), input.id, input.userId)
    .run();
  if (result.meta.changes === 0) await requireOwnedStream(input.database, input.userId, input.id);
}

/** 所有する live セッションをすべて終了し、次回作成までの待機秒数を返す。 */
export async function stopAllLiveStreams(input: {
  database: StreamDatabase;
  userId: number;
  settings: StreamSettings;
  now?: Date;
}): Promise<StopLiveStreamsResponse> {
  const now = input.now ?? new Date();
  const latest = await input.database
    .prepare('SELECT MAX(started_at) AS started_at FROM stream_sessions WHERE user_id = ?')
    .bind(input.userId)
    .first<{ started_at: string | null }>();
  const result = await input.database
    .prepare(
      `UPDATE stream_sessions
       SET status = 'ended', ended_at = ?, end_reason = 'user_stop', kick_pending = 1
       WHERE user_id = ? AND status = 'live'`
    )
    .bind(now.toISOString(), input.userId)
    .run();

  return {
    stopped: result.meta.changes,
    retryAfterSeconds: retryAfterSeconds(latest?.started_at ?? null, now, input.settings),
  };
}

/** 所有するセッションの状態を返す。他人の ID は不存在と同じ 404。 */
export async function getStreamStatus(input: {
  database: StreamDatabase;
  userId: number;
  id: string;
}): Promise<StreamStatusResponse> {
  return toStatusResponse(await requireOwnedStream(input.database, input.userId, input.id));
}

async function insertStream(
  input: StreamServiceInput,
  id: string,
  now: Date,
  expiresAt: Date,
  rateThreshold: string
): Promise<boolean> {
  const iso = now.toISOString();
  const result = await input.database
    .prepare(
      `INSERT INTO stream_sessions (
         id, user_id, status, started_at, extend_expires_at,
         last_heartbeat_at, last_viewer_at, kick_pending, start_token
       )
       SELECT ?, ?, 'live', ?, ?, ?, ?, 0, ?
       WHERE (SELECT COUNT(*) FROM stream_sessions WHERE status = 'live') < ?
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
      id,
      input.userId,
      iso,
      expiresAt.toISOString(),
      iso,
      iso,
      input.startToken ?? null,
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
  return result.meta.changes > 0;
}

async function throwCreateRejection(
  database: StreamDatabase,
  userId: number,
  rateThreshold: string,
  settings: StreamSettings,
  startToken?: string | null
): Promise<never> {
  if (startToken) {
    const cancellation = await database
      .prepare(
        'SELECT start_token FROM stream_start_cancellations WHERE user_id = ? AND start_token = ?'
      )
      .bind(userId, startToken)
      .first<{ start_token: string }>();
    if (cancellation) {
      throw new StreamError(409, ERROR_CODES.streamStartCancelled, '取り消された配信開始操作です');
    }
    await throwIfExistingStartToken(database, userId, startToken);
  }
  const active = await database
    .prepare("SELECT COUNT(*) AS count FROM stream_sessions WHERE user_id = ? AND status = 'live'")
    .bind(userId)
    .first<{ count: number }>();
  const allLive = await database
    .prepare("SELECT COUNT(*) AS count FROM stream_sessions WHERE status = 'live'")
    .bind()
    .first<{ count: number }>();
  if ((allLive?.count ?? 0) >= settings.maxLiveStreams) {
    throw new StreamError(429, ERROR_CODES.streamCapacityReached, '配信の同時接続上限に達しました');
  }
  if ((active?.count ?? 0) >= settings.maxLiveStreamsPerUser) {
    throw new StreamError(409, ERROR_CODES.streamAlreadyLive, '既に配信中です');
  }
  const recent = await database
    .prepare('SELECT id FROM stream_sessions WHERE user_id = ? AND started_at > ? LIMIT 1')
    .bind(userId, rateThreshold)
    .first<{ id: string }>();
  if (recent) {
    throw new StreamError(429, ERROR_CODES.streamCreateRateLimited, '配信の再作成が速すぎます');
  }
  throw new Error('Stream reservation was rejected unexpectedly');
}

async function streamIdExists(database: StreamDatabase, id: string): Promise<boolean> {
  return Boolean(
    await database.prepare('SELECT id FROM stream_sessions WHERE id = ?').bind(id).first<{ id: string }>()
  );
}

async function requireOwnedStream(
  database: StreamDatabase,
  userId: number,
  id: string
): Promise<StreamRow> {
  const row = await database
    .prepare(
      `SELECT id, user_id, status, started_at, extend_expires_at,
              last_heartbeat_at, ended_at, end_reason
       FROM stream_sessions WHERE id = ? AND user_id = ?`
    )
    .bind(id, userId)
    .first<StreamRow>();
  if (!row) throw new StreamError(404, ERROR_CODES.notFound, '配信セッションが見つかりません');
  return row;
}

function endedError(): StreamError {
  return new StreamError(409, ERROR_CODES.streamEnded, '終了した配信は更新できません');
}


function createResponse(
  id: string,
  now: Date,
  expiresAt: Date,
  publishToken: string
): CreateStreamResponse {
  return {
    id,
    streamUrl: streamUrl(id),
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

function toStatusResponse(row: StreamRow): StreamStatusResponse {
  return {
    id: row.id,
    streamUrl: streamUrl(row.id),
    status: row.status,
    startedAt: row.started_at,
    extendExpiresAt: row.extend_expires_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
  };
}

function streamUrl(id: string): string {
  return `${STREAM_BASE_URL}/${id}`;
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function retryAfterSeconds(
  latestStartedAt: string | null,
  now: Date,
  settings: StreamSettings
): number {
  if (!latestStartedAt) return 0;
  const elapsedSeconds = (now.getTime() - Date.parse(latestStartedAt)) / 1000;
  return Math.max(0, Math.ceil(settings.createIntervalSeconds - elapsedSeconds));
}

function toNumericDate(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/** JWT NumericDate と ISO8601/D1 時刻の基準を同じ秒へ揃える。 */
function truncateToSeconds(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}
