/**
 * JWKS 応答へ他サービス（ちょいキャス）の公開鍵を併載する。
 *
 * 配信サーバーの `authJWTJWKS` が 1 本しか持てないため、cutover までの間だけ
 * WebScreen の `/api/streams/jwks/` が choicast の公開鍵も返す。取得は infra の
 * `fetchRemoteJwks` に任せ、ここでは Worker isolate ごとのキャッシュ・鍵の絞り込み・
 * `kid` 衝突時の自鍵優先・失敗の記録を担う。
 *
 * cutover 完了後に WebScreen の画面共有ごと削除する一時コード。
 */

import { fetchRemoteJwks, type RemoteJwksFetcher, type RemoteRsaPublicJwk } from '../infra/remote-jwks';
import { logStreamJwksMergeFailure } from '../observability/worker-log';
import type { PublicJwk } from './stream-jwt';

/** 取得成功の保持時間。鍵の追加が反映されるまでの遅れとして許容する幅。 */
const SUCCESS_TTL_MS = 5 * 60 * 1000;

/**
 * 取得失敗の保持時間。失敗を全く保持しないと、上流が落ちている間の JWKS 要求ごとに
 * 接続の timeout を待って warn を出し続ける。成功より短くして復旧は早く拾う。
 */
const FAILURE_TTL_MS = 30 * 1000;

interface CacheEntry {
  keys: RemoteRsaPublicJwk[];
  expiresAt: number;
}

/** Worker isolate ごとの module-level キャッシュ（URL 単位）。 */
const cache = new Map<string, CacheEntry>();

export interface MergeRemoteJwksOptions {
  fetcher?: RemoteJwksFetcher;
  now?: () => number;
}

/** テストがキャッシュの影響を切るためだけに使う。 */
export function resetRemoteJwksCache(): void {
  cache.clear();
}

/** 併載する鍵を取得する。失敗時は空配列（自鍵だけを返す）にし、warn を 1 行出す。 */
async function remoteKeys(
  url: string,
  { fetcher, now = Date.now }: MergeRemoteJwksOptions
): Promise<RemoteRsaPublicJwk[]> {
  const current = now();
  const cached = cache.get(url);
  if (cached && cached.expiresAt > current) return cached.keys;

  // fetchRemoteJwks は投げない契約だが、併載の失敗で自鍵の応答（500）まで巻き込まない
  // ように、ここでも例外を失敗結果に畳む。
  const result = await fetchRemoteJwks(url, fetcher).catch((error: unknown) => ({
    ok: false as const,
    reason: 'unexpected' as const,
    errorName: error instanceof Error ? error.name : undefined,
  }));
  if (!result.ok) {
    logStreamJwksMergeFailure({
      reason: result.reason,
      upstreamStatus: 'upstreamStatus' in result ? result.upstreamStatus : undefined,
      errorName: result.errorName,
    });
    cache.set(url, { keys: [], expiresAt: current + FAILURE_TTL_MS });
    return [];
  }
  cache.set(url, { keys: result.keys, expiresAt: current + SUCCESS_TTL_MS });
  return result.keys;
}

/**
 * 自鍵の後ろに他サービスの公開鍵を並べる。`kid` が自鍵と重なる鍵は自鍵を優先して捨てる
 * （MediaMTX は `kid` で鍵を引くため、重複があると検証に使う鍵が不定になる）。
 */
export async function mergeRemoteJwks(
  own: PublicJwk[],
  url: string,
  options: MergeRemoteJwksOptions = {}
): Promise<PublicJwk[]> {
  const ownKids = new Set(own.map((key) => key.kid));
  const merged = [...own];
  const seen = new Set(ownKids);
  for (const key of await remoteKeys(url, options)) {
    if (seen.has(key.kid)) continue;
    seen.add(key.kid);
    merged.push({ ...key, alg: 'RS256', use: 'sig', key_ops: ['verify'] });
  }
  return merged;
}
