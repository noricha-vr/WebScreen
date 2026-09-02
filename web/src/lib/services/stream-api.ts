import { ERROR_CODES, type ErrorResponse } from '../contracts/api';
import { isShortId } from '../contracts/r2key';
import { logWorkerFailure } from '../observability/worker-log';
import { importSigningKey } from '../contracts/session';
import { requireUser, type AuthDatabase } from './auth';
import { createStreamJwtKeySet } from './stream-jwt';
import { StreamError, type StreamDatabase, type StreamJwtSigner, type StreamSettings } from './streams';

const DEFAULT_EXTENSION_SECONDS = 2 * 60 * 60;
const DEFAULT_MAX_LIVE_STREAMS = 1;
const DEFAULT_MAX_TOTAL_LIVE_STREAMS = 20;
const DEFAULT_CREATE_INTERVAL_SECONDS = 10;

export interface StreamApiBindings {
  DB: StreamDatabase & AuthDatabase;
  SESSION_SIGNING_KEY: string;
  STREAM_JWT_PRIVATE_KEY: string;
  STREAM_EXTENSION_SECONDS?: string;
  STREAM_MAX_LIVE_PER_USER?: string;
  STREAM_MAX_LIVE?: string;
  STREAM_CREATE_INTERVAL_SECONDS?: string;
}

export interface StreamApiContext {
  database: StreamDatabase;
  userId: number;
  settings: StreamSettings;
  signPublishToken: StreamJwtSigner;
}

/** Cookie 認証・設定・JWT signer を揃えて stream API の処理を実行する。 */
export async function runStreamApi(
  request: Request,
  bindings: StreamApiBindings,
  action: (context: StreamApiContext) => Promise<Response>
): Promise<Response> {
  try {
    const signingKey = await importSigningKey(bindings.SESSION_SIGNING_KEY);
    const authenticated = await requireUser(request, { db: bindings.DB, signingKey });
    if (!authenticated.ok) return json(authenticated.error, authenticated.status);
    return await action({
      database: bindings.DB,
      userId: authenticated.user.id,
      settings: streamSettings(bindings),
      signPublishToken: async (input) =>
        (await createStreamJwtKeySet(bindings.STREAM_JWT_PRIVATE_KEY)).signer(input),
    });
  } catch (error) {
    if (error instanceof StreamError) {
      return errorResponse(error.status, error.errorCode, error.message);
    }
    logWorkerFailure({
      event: 'stream_api_failed',
      errorCode: ERROR_CODES.internalError,
      status: 500,
      errorName: error instanceof Error ? error.name : undefined,
    });
    return errorResponse(500, ERROR_CODES.internalError, '配信セッションの処理に失敗しました');
  }
}

/** Astro の動的 path parameter を 12 文字 base62 の ID として検証する。 */
export function requireStreamId(value: string | undefined): string {
  if (!value || !isShortId(value)) {
    throw new StreamError(404, ERROR_CODES.notFound, '配信セッションが見つかりません');
  }
  return value;
}

export function streamSettings(bindings: StreamApiBindings): StreamSettings {
  return {
    extensionCycleSeconds: positiveInt(bindings.STREAM_EXTENSION_SECONDS, DEFAULT_EXTENSION_SECONDS),
    maxLiveStreamsPerUser: positiveInt(
      bindings.STREAM_MAX_LIVE_PER_USER,
      DEFAULT_MAX_LIVE_STREAMS
    ),
    maxLiveStreams: positiveInt(bindings.STREAM_MAX_LIVE, DEFAULT_MAX_TOTAL_LIVE_STREAMS),
    createIntervalSeconds: positiveInt(
      bindings.STREAM_CREATE_INTERVAL_SECONDS,
      DEFAULT_CREATE_INTERVAL_SECONDS
    ),
  };
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

/** 公開 JWKS を返し、秘密鍵の構成不良は安全な 500 として記録する。 */
export async function streamJwksResponse(secret: string): Promise<Response> {
  try {
    const { jwks } = await createStreamJwtKeySet(secret);
    return Response.json(jwks, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    logWorkerFailure({
      event: 'stream_jwks_failed',
      errorCode: ERROR_CODES.internalError,
      status: 500,
      errorName: error instanceof Error ? error.name : undefined,
    });
    return Response.json(
      { errorCode: ERROR_CODES.internalError, message: '公開鍵の取得に失敗しました' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}

function errorResponse(
  status: number,
  errorCode: ErrorResponse['errorCode'],
  message: string
): Response {
  return json({ errorCode, message }, status);
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('Invalid stream setting');
  return parsed;
}
