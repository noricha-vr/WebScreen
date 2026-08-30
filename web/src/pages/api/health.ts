import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import {
  createCronHealthReader,
  type CronRunDatabase,
} from '../../lib/services/cron-health';

// SSR 経路の疎通確認用。middleware が付ける COOP/COEP の実測点も兼ねる
// （prerender=true だと静的化され Worker を通らないため false 固定）。
export const prerender = false;

interface VersionMetadata {
  id: string;
  tag?: string;
}

interface HealthBindings {
  CF_VERSION_METADATA?: VersionMetadata;
  DB?: CronRunDatabase;
}

/**
 * module スコープで作ることで isolate 単位のキャッシュになる。この経路は無認証なので、
 * 素通しだとリクエストごとに D1 read が走る（バッチは毎時なので秒単位の鮮度は要らない）。
 */
const readCronSection = createCronHealthReader();

/**
 * 応答に自分のバージョンと cron の鮮度を含める。
 *
 * デプロイ直後の疎通確認は、200 が返るだけでは「新しい版が配信されている」ことの
 * 証明にならない（旧版が生きていても 200 を返す）。CI はこの id とデプロイ結果の
 * バージョン ID を突き合わせて反映を判定する。
 *
 * cron は保持期間バッチの最終成功からの経過。Cloudflare のダッシュボードを人が
 * 見に行かなくても、この 1 本で「バッチが動いているか」を外から確認できる。
 * status / version の形は CI の疎通確認が文字列で見ているので変えない。
 */
export const GET: APIRoute = async () => {
  const bindings = env as unknown as HealthBindings;
  const version = bindings.CF_VERSION_METADATA?.id ?? null;
  const cron = await readCronSection(bindings.DB, new Date());

  return new Response(JSON.stringify({ status: 'ok', version, cron }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
