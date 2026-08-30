/**
 * 削除した動画の公開 URL を Cloudflare のキャッシュから落とす。
 *
 * 削除経路（services/movies.ts の deleteMovie と services/retention.ts の各掃除）は
 * どれもここを通す。shortId から公開 URL を組み立てる規則と、1 リクエスト 30 URL の
 * 分割を 1 箇所に置き、経路ごとに書き分けない。
 *
 * 設定（ゾーン ID / API token / 配信元）は entry 層（pages/ と cron/）が bindings から
 * 素の文字列で渡す。entry は infra を直接叩けない（docs/architecture-contract.toml）ため、
 * 設定の型はここで定義して公開する。
 */

import { movieUrl } from '../contracts/r2key';
import {
  MAX_URLS_PER_PURGE,
  isPurgeZoneId,
  purgeCachedUrls,
  type PurgeFetcher,
} from '../infra/cloudflare-purge';

export interface CachePurgeSettings {
  /** 動画の配信元（R2_PUBLIC_BASE_URL）。表示に使うものと同じ値であること。 */
  publicBaseUrl: string;
  /** CLOUDFLARE_ZONE_ID。未設定・形式不正なら purge せず、呼び出しごとに 1 行 warn する。 */
  zoneId: string;
  /** CLOUDFLARE_PURGE_TOKEN（secret）。ローカル開発では空になる。 */
  apiToken: string;
  /** ログの出所（呼び出す Worker の名前）。 */
  source: string;
  /** テストで実ネットワークを使わないための注入口。本番では省略する。 */
  fetcher?: PurgeFetcher;
}

/** 1 回の purge 実行の内訳。cron はこれを構造化ログに載せる。 */
export interface CachePurgeResult {
  /** Cloudflare API を叩いた回数（30 URL ごとに 1 回）。 */
  requests: number;
  /** そのうち失敗した回数。0 以外でも削除自体は完了しており、最大 120 分で自然に切れる。 */
  failures: number;
}

const NOTHING_TO_PURGE: CachePurgeResult = { requests: 0, failures: 0 };

/** ログの理由文。event 名と 1 対 1 で対応させる。 */
const PURGE_ISSUE_REASONS = {
  cache_purge_skipped: 'purge is not configured',
  cache_purge_url_invalid: 'public urls are not buildable',
  movie_delete_cache_purge_failed: 'the owner deleted a movie but the purge request failed',
} as const;

/**
 * 削除済み動画のキャッシュを落とす。例外は投げない（削除の成否を左右しない）。
 *
 * 呼ぶのは R2 の実体を消した後だけ。実体が残っている状態で purge しても、次の取得で
 * 同じものがキャッシュへ戻るだけで意味がない。
 */
export async function purgeMovieCache(
  shortIds: string[],
  settings: CachePurgeSettings
): Promise<CachePurgeResult> {
  // 消すものが無い実行では設定も見ない（毎時の空回り cron が warn を吐き続けないため）。
  if (shortIds.length === 0) return NOTHING_TO_PURGE;

  if (!isPurgeZoneId(settings.zoneId) || settings.apiToken === '') {
    logPurgeIssue(settings.source, 'cache_purge_skipped', shortIds.length);
    return NOTHING_TO_PURGE;
  }

  let requests = 0;
  let failures = 0;
  for (let index = 0; index < shortIds.length; index += MAX_URLS_PER_PURGE) {
    const chunk = shortIds.slice(index, index + MAX_URLS_PER_PURGE);
    requests += 1;
    try {
      const urls = chunk.map((shortId) => movieUrl(settings.publicBaseUrl, shortId));
      const purged = await purgeCachedUrls({
        urls,
        zoneId: settings.zoneId,
        apiToken: settings.apiToken,
        source: settings.source,
        fetcher: settings.fetcher,
      });
      if (!purged) failures += 1;
    } catch {
      // 公開 URL を組み立てられなかった（配信元 URL か shortId が不正）。削除は済んで
      // いるので落とさず、残りのチャンクを続ける。設定ミスでしか起きないので、
      // 黙って件数だけ増やさずログにも残す。
      logPurgeIssue(settings.source, 'cache_purge_url_invalid', chunk.length);
      failures += 1;
    }
  }

  return { requests, failures };
}

/**
 * purge できなかった理由を 1 行 JSON で残す（1 回の呼び出しにつき 1 行）。
 *
 * ローカル開発（secret 無し）では毎回 skipped になるのが正常なので warn 止まりにする。
 * 本番でこの行が出ていたら、削除したのに最大 120 分配信され続けている印。
 * URL は出さない（shortId が動画の唯一の保護なので、ログに焼かない）。
 */
/**
 * 所有者の削除で purge が失敗したことを残す。
 *
 * バッチは件数を summary（cachePurgeRequests / cachePurgeFailures）に出せるが、対話
 * 削除にはその出口が無い。infra 側の cache_purge_failed だけだと「利用者が消したのに
 * 見え続けている」経路かどうかを後から切り分けられないので、削除側でも 1 行残す。
 */
export function logMovieDeletePurgeFailure(source: string): void {
  logPurgeIssue(source, 'movie_delete_cache_purge_failed', 1);
}

function logPurgeIssue(
  source: string,
  event: 'cache_purge_skipped' | 'cache_purge_url_invalid' | 'movie_delete_cache_purge_failed',
  count: number
): void {
  const reason = PURGE_ISSUE_REASONS[event];
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      source,
      severity: 'warn',
      kind: 'event',
      level: 'warn',
      event,
      count,
      summary: `cache purge left ${count} urls cached (${reason}); they expire within 120 minutes.`,
    })
  );
}
