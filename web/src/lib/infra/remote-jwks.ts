/**
 * 他サービスの公開 JWKS を取得する境界。
 *
 * 画面共有を「ちょいキャス」（app.choicast.com）へ分離する間、配信サーバー（MediaMTX
 * ingress）の `authJWTJWKS` は 1 本しか設定できないため、WebScreen の JWKS 応答へ
 * choicast の公開鍵を併載する。その取得だけを担う。取得するのは公開鍵で、秘密情報は
 * 含まれない。
 *
 * 例外を投げないのが契約。併載は付帯機能であり、取得の失敗で自鍵の JWKS まで
 * 落とすと WebScreen 側の配信が止まる。失敗理由は結果で返し、記録は呼び出し側が行う
 * （infra 層は observability に依存しない）。
 *
 * cutover 完了後に WebScreen の画面共有ごと削除する一時コード。
 */

/**
 * 応答を待つ上限。上流が応答しない時に MediaMTX の JWKS 取得をこれ以上待たせない
 * （待ち続けて得られるのは併載だけで、自鍵の応答が遅れる方が損失が大きい）。
 */
const REQUEST_TIMEOUT_MS = 5000;

/** 応答本文の上限。公開鍵数個の JWKS には十分で、異常な応答を丸ごと読まないための蓋。 */
const MAX_BODY_BYTES = 64 * 1024;

/** fetch の注入境界（テストで実ネットワークを使わないため）。 */
export type RemoteJwksFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const defaultFetch: RemoteJwksFetcher = (input, init) => globalThis.fetch(input, init);

/** 併載に使う公開鍵。上流の任意フィールドをそのまま返さず、必要な要素だけに射影する。 */
export interface RemoteRsaPublicJwk {
  kty: 'RSA';
  kid: string;
  n: string;
  e: string;
}

export type RemoteJwksFailureReason =
  | 'request_failed'
  | 'rejected'
  | 'body_too_large'
  | 'invalid_json'
  | 'invalid_shape';

export type RemoteJwksResult =
  | { ok: true; keys: RemoteRsaPublicJwk[] }
  | { ok: false; reason: RemoteJwksFailureReason; upstreamStatus?: number; errorName?: string };

/** `keys` の要素が併載できる RSA 公開鍵か（`kid` `n` `e` が非空文字列であること）。 */
function toRsaPublicJwk(candidate: unknown): RemoteRsaPublicJwk | undefined {
  if (typeof candidate !== 'object' || candidate === null) return undefined;
  const { kty, kid, n, e } = candidate as Record<string, unknown>;
  if (kty !== 'RSA') return undefined;
  if (typeof kid !== 'string' || kid === '') return undefined;
  if (typeof n !== 'string' || n === '') return undefined;
  if (typeof e !== 'string' || e === '') return undefined;
  return { kty: 'RSA', kid, n, e };
}

/**
 * JWKS を 1 回取得し、併載できる RSA 公開鍵だけを返す。
 *
 * `keys` が配列でない・JSON でない・非 200・接続失敗はすべて失敗として返す。
 * 配列の中の「RSA でない」「必須要素が欠ける」鍵は黙って読み飛ばす（他サービスが
 * 別種の鍵を並べていても、こちらが使える鍵まで捨てる理由はない）。
 */
export async function fetchRemoteJwks(
  url: string,
  fetcher: RemoteJwksFetcher = defaultFetch
): Promise<RemoteJwksResult> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      reason: 'request_failed',
      errorName: error instanceof Error ? error.name : undefined,
    };
  }

  if (response.status !== 200) {
    return { ok: false, reason: 'rejected', upstreamStatus: response.status };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    return {
      ok: false,
      reason: 'request_failed',
      upstreamStatus: response.status,
      errorName: error instanceof Error ? error.name : undefined,
    };
  }
  if (text.length > MAX_BODY_BYTES) {
    return { ok: false, reason: 'body_too_large', upstreamStatus: response.status };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid_json',
      upstreamStatus: response.status,
      errorName: error instanceof Error ? error.name : undefined,
    };
  }

  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (typeof parsed !== 'object' || parsed === null || !Array.isArray(keys)) {
    return { ok: false, reason: 'invalid_shape', upstreamStatus: response.status };
  }

  const accepted: RemoteRsaPublicJwk[] = [];
  for (const candidate of keys) {
    const jwk = toRsaPublicJwk(candidate);
    if (jwk) accepted.push(jwk);
  }
  return { ok: true, keys: accepted };
}
