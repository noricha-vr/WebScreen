import { ERROR_CODES, type ErrorResponse } from '../contracts/api';
import {
  OAUTH_STATE_TTL_SECONDS,
  SESSION_COOKIE_NAME,
  base64UrlDecode,
  base64UrlEncode,
  createSessionPayload,
  generateOAuthState,
  matchesOAuthState,
  signSession,
  verifySession,
} from '../contracts/session';
import {
  DiscordApiError,
  createDiscordAuthorizeUrl,
  fetchDiscordIdentity,
  type Fetcher,
} from '../infra/discord';
import {
  findUserById,
  upsertDiscordUser,
  type AuthUser,
  type UsersDatabase,
} from '../infra/users';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface OAuthStatePayload {
  state: string;
  exp: number;
}

/** 認証サービスへ注入する D1 users binding。 */
export type AuthDatabase = UsersDatabase;

/** 発行した OAuth state と署名済み Cookie 値。 */
export interface OAuthState {
  state: string;
  cookieValue: string;
}

/** requireUser の認証成功・失敗結果。 */
export type RequireUserResult =
  | { ok: true; user: AuthUser }
  | { ok: false; status: 401; error: ErrorResponse };

/** Discord API 障害を callback の 502 応答へ変換するためのサービス境界エラー。 */
export class OAuthUpstreamError extends Error {
  constructor() {
    super('Discord OAuth request failed');
    this.name = 'OAuthUpstreamError';
  }
}

/** 署名付き OAuth state Cookie を作る。時刻・乱数はテストから注入できる。 */
export async function createOAuthState(
  signingKey: CryptoKey,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  stateGenerator: () => string = generateOAuthState
): Promise<OAuthState> {
  const state = stateGenerator();
  const payload: OAuthStatePayload = { state, exp: nowSeconds + OAUTH_STATE_TTL_SECONDS };
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(encodedPayload));
  return {
    state,
    cookieValue: `${encodedPayload}.${base64UrlEncode(new Uint8Array(signature))}`,
  };
}

/** state Cookie を先に削除してから、署名・期限・query state の一致を検証する。 */
export async function consumeOAuthState(
  readAndDeleteCookie: () => string | undefined,
  callbackState: string,
  signingKey: CryptoKey,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const token = readAndDeleteCookie();
  if (!token) return false;

  const payload = await verifyOAuthStateToken(token, signingKey, nowSeconds);
  return payload !== null && matchesOAuthState(payload.state, callbackState);
}

/** identify scope の Discord ログイン URL を返す。 */
export function buildDiscordLoginUrl(
  clientId: string,
  redirectUri: string,
  state: string
): string {
  return createDiscordAuthorizeUrl(clientId, redirectUri, state);
}

/** Discord callback を完了し、users upsert とセッション発行を行う。 */
export async function completeDiscordOAuth(
  code: string,
  redirectUri: string,
  deps: {
    clientId: string;
    clientSecret: string;
    db: UsersDatabase;
    signingKey: CryptoKey;
    fetcher?: Fetcher;
    nowSeconds?: number;
  }
): Promise<{ user: AuthUser; sessionCookieValue: string }> {
  let identity;
  try {
    identity = await fetchDiscordIdentity(
      code,
      deps.clientId,
      deps.clientSecret,
      redirectUri,
      deps.fetcher
    );
  } catch (error) {
    if (error instanceof DiscordApiError) throw new OAuthUpstreamError();
    throw error;
  }

  const user = await upsertDiscordUser(
    deps.db,
    identity.id,
    identity.name,
    identity.avatar
  );
  const sessionCookieValue = await signSession(
    createSessionPayload(user.id, deps.nowSeconds),
    deps.signingKey
  );
  return { user, sessionCookieValue };
}

/** セッション Cookie を検証し、D1 の現在ユーザーを返す。 */
export async function requireUser(
  request: Request,
  deps: { db: UsersDatabase; signingKey: CryptoKey; nowSeconds?: number }
): Promise<RequireUserResult> {
  const token = readCookie(request.headers.get('Cookie'), SESSION_COOKIE_NAME);
  if (token) {
    const session = await verifySession(token, deps.signingKey, deps.nowSeconds);
    if (session) {
      const user = await findUserById(deps.db, session.uid);
      if (user) return { ok: true, user };
    }
  }

  return {
    ok: false,
    status: 401,
    error: { errorCode: ERROR_CODES.unauthorized, message: '認証が必要です' },
  };
}

async function verifyOAuthStateToken(
  token: string,
  signingKey: CryptoKey,
  nowSeconds: number
): Promise<OAuthStatePayload | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, encodedSignature] = parts as [string, string];
  if (!encodedPayload || !encodedSignature) return null;

  let signature: Uint8Array<ArrayBuffer>;
  let payloadBytes: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlDecode(encodedSignature);
    payloadBytes = base64UrlDecode(encodedPayload);
  } catch {
    return null;
  }

  const valid = await crypto.subtle.verify(
    'HMAC',
    signingKey,
    signature,
    encoder.encode(encodedPayload)
  );
  if (!valid) return null;

  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(payloadBytes));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { state, exp } = value as Record<string, unknown>;
  if (typeof state !== 'string' || state.length === 0) return null;
  if (typeof exp !== 'number' || !Number.isInteger(exp) || exp <= nowSeconds) return null;
  return { state, exp };
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}
