/**
 * セッション Cookie の契約。
 *
 * 署名付き Cookie に uid を載せるだけのステートレス方式（D1 にセッション行を持たない）。
 * 発行側（OAuth コールバック）と検証側（middleware・API ハンドラ）が同じ規則で
 * 読み書きするため、名前・TTL・署名形式をここに固定する。
 *
 * Web 標準 API のみで実装する（`crypto.subtle` / `TextEncoder`）。
 * node:crypto・Buffer を使うと workerd で動かないため禁止。
 */

/** ログインセッションの Cookie 名。 */
export const SESSION_COOKIE_NAME = 'ws_session';

/** OAuth の CSRF 対策 state を一時保持する Cookie 名。 */
export const OAUTH_STATE_COOKIE_NAME = 'ws_oauth_state';

/** Cookie ヘッダーから指定名のデコード済み値を取得する。不正なエンコードは無効として扱う。 */
export function readCookie(header: string | null, name: string): string | null {
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

/** セッションの有効期間（30 日）。payload.exp は発行時刻 + この秒数。 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** state Cookie の有効期間（10 分）。使い捨て（検証後に必ず削除する）。 */
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

/** Cookie 属性の共通値。Secure は本番 https 前提（ローカル dev では Astro が緩和しない点に注意）。 */
export const SESSION_COOKIE_ATTRIBUTES = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
} as const;

/** Cookie に載せる最小のセッション情報。個人情報は入れない（uid から D1 で引く）。 */
export interface SessionPayload {
  /** users.id */
  uid: number;
  /** 有効期限（UNIX 秒） */
  exp: number;
}

const SIGNATURE_SEPARATOR = '.';

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// 署名・検証
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * 署名鍵をインポートする。secret は Cloudflare Secret（SESSION_SIGNING_KEY）から渡す。
 * リクエストごとに importKey するとコストがかかるので、呼び出し側でモジュールスコープに保持してよい。
 */
export function importSigningKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/**
 * Cookie 値を組み立てる: `base64url(payload).base64url(HMAC-SHA256(...))`。
 *
 * HMAC の対象は「base64url エンコード済みの payload 文字列」。生の JSON ではなく
 * 送信されるバイト列そのものに署名することで、エンコード揺れによる検証すり抜けを防ぐ。
 */
export async function signSession(payload: SessionPayload, key: CryptoKey): Promise<string> {
  const encodedPayload = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(encodedPayload));
  return `${encodedPayload}${SIGNATURE_SEPARATOR}${base64UrlEncode(new Uint8Array(signature))}`;
}

/**
 * Cookie 値を検証する。改竄・期限切れ・形式不正はすべて null を返す
 * （呼び出し側は「未ログイン」として同一に扱えばよく、理由の出し分けはしない）。
 *
 * @param nowSeconds 現在時刻（UNIX 秒）。テストから注入できるよう引数にしている。
 */
export async function verifySession(
  token: string,
  key: CryptoKey,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<SessionPayload | null> {
  const parts = token.split(SIGNATURE_SEPARATOR);
  if (parts.length !== 2) return null;

  const [encodedPayload, encodedSignature] = parts as [string, string];
  if (encodedPayload.length === 0 || encodedSignature.length === 0) return null;

  let signature: Uint8Array<ArrayBuffer>;
  let payloadBytes: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlDecode(encodedSignature);
    payloadBytes = base64UrlDecode(encodedPayload);
  } catch {
    return null;
  }

  // 文字列比較ではなく subtle.verify を使う（タイミング差で署名を推測されないため）。
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    encoder.encode(encodedPayload)
  );
  if (!valid) return null;

  const payload = parseSessionPayload(payloadBytes);
  if (!payload) return null;
  if (payload.exp <= nowSeconds) return null;

  return payload;
}

/** 発行時刻から exp を決めて payload を作る。 */
export function createSessionPayload(
  uid: number,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): SessionPayload {
  return { uid, exp: nowSeconds + SESSION_TTL_SECONDS };
}

function parseSessionPayload(bytes: Uint8Array): SessionPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const { uid, exp } = parsed as Record<string, unknown>;
  if (typeof uid !== 'number' || !Number.isInteger(uid) || uid <= 0) return null;
  if (typeof exp !== 'number' || !Number.isInteger(exp)) return null;

  return { uid, exp };
}

// ---------------------------------------------------------------------------
// OAuth state
// ---------------------------------------------------------------------------

/** state の長さ（バイト）。base64url で 32 文字になる。 */
const OAUTH_STATE_BYTES = 24;

/** CSRF 対策の state を生成する。Cookie とリダイレクト URL の両方に同じ値を載せる。 */
export function generateOAuthState(): string {
  const bytes = new Uint8Array(OAUTH_STATE_BYTES);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/**
 * Cookie の state とコールバックの state を突き合わせる。
 * 長さを揃えたうえで全バイトを走査し、早期 return しない（タイミング差を作らない）。
 */
export function matchesOAuthState(cookieState: string, callbackState: string): boolean {
  if (cookieState.length === 0 || cookieState.length !== callbackState.length) return false;

  let diff = 0;
  for (let i = 0; i < cookieState.length; i += 1) {
    diff |= cookieState.charCodeAt(i) ^ callbackState.charCodeAt(i);
  }
  return diff === 0;
}
