/**
 * Cloudflare のキャッシュ purge API を叩く境界。
 *
 * 配信は R2 の Custom Domain（cdn.web-screen.net）経由で、mp4 は Cloudflare の
 * 既定キャッシュ対象。R2 から実体を消しても Edge のキャッシュは最大 120 分残るため、
 * 削除の直後にここで URL 単位の purge を投げる（docs/r2-delivery.md）。
 *
 * 例外を投げないのが契約。purge は削除の後始末であり、失敗しても R2 / D1 の削除は
 * 既に済んでいる（利用者にとっての削除は完了している）。ここで投げると「消えたのに
 * 削除が失敗した」と伝わるうえ、キャッシュは 120 分で自然に切れる。
 */

/** 1 リクエストに載せられる URL の上限（Cloudflare API の制約）。超える分は呼び出し側が分割する。 */
export const MAX_URLS_PER_PURGE = 30;

/**
 * 応答を待つ上限。Cloudflare API が応答しない時に、削除リクエストの応答（DELETE の 204）や
 * cron の実行枠をこれ以上待たせない。待ち続けて得られるのは 120 分の短縮だけ。
 */
const REQUEST_TIMEOUT_MS = 5000;

/** ゾーン ID の形式。設定ミスをそのまま URL へ連結しないための検査。 */
const ZONE_ID_PATTERN = /^[0-9a-f]{32}$/;

/** fetch の注入境界（テストで実ネットワークを使わないため）。 */
export type PurgeFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const defaultFetch: PurgeFetcher = (input, init) => globalThis.fetch(input, init);

export interface PurgeCachedUrlsInput {
  /** purge する公開 URL。MAX_URLS_PER_PURGE 件以内であること（分割は呼び出し側の責務）。 */
  urls: string[];
  zoneId: string;
  apiToken: string;
  /** ログの出所（呼び出す Worker の名前）。本体と cron の両方から呼ばれる。 */
  source: string;
  fetcher?: PurgeFetcher;
}

/** ゾーン ID が使える形式か。空・形式不正はどちらも「未設定」として扱う。 */
export function isPurgeZoneId(zoneId: string): boolean {
  return ZONE_ID_PATTERN.test(zoneId);
}

/**
 * 失敗を 1 行 JSON で残す。
 *
 * URL は出さない。動画の URL は 12 文字の shortId が唯一の保護なので、ログに焼くと
 * 保護の強さがログを読める範囲まで落ちる。件数と HTTP ステータスがあれば
 * observability での切り分けには足りる（API token も当然出さない）。
 */
function logFailure(
  source: string,
  reason: 'request_failed' | 'rejected',
  count: number,
  status?: number
): void {
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      source,
      severity: 'warn',
      kind: 'event',
      event: 'cache_purge_failed',
      reason,
      status,
      count,
      summary: `cache purge for ${count} urls failed (${reason}); stale copies expire within 120 minutes.`,
    })
  );
}

/**
 * URL 単位のキャッシュ purge を 1 回投げる。成功で true、失敗で false（例外は投げない）。
 *
 * 判定は HTTP ステータスだけで行う。Cloudflare は拒否を非 2xx で返すため、本文の
 * `success` を読んでも判断は変わらない（JSON パースという失敗経路が増えるだけ）。
 */
export async function purgeCachedUrls(input: PurgeCachedUrlsInput): Promise<boolean> {
  if (input.urls.length === 0) return true;
  if (!isPurgeZoneId(input.zoneId) || input.apiToken === '') return false;

  const fetcher = input.fetcher ?? defaultFetch;
  let response: Response;
  try {
    response = await fetcher(
      `https://api.cloudflare.com/client/v4/zones/${input.zoneId}/purge_cache`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${input.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ files: input.urls }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
  } catch {
    // タイムアウト（AbortError）もここに来る。理由で分けず、送れなかった事実だけ残す。
    logFailure(input.source, 'request_failed', input.urls.length);
    return false;
  }

  if (!response.ok) {
    logFailure(input.source, 'rejected', input.urls.length, response.status);
    return false;
  }
  return true;
}
