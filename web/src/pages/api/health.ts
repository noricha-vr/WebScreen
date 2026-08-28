import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

// SSR 経路の疎通確認用。middleware が付ける COOP/COEP の実測点も兼ねる
// （prerender=true だと静的化され Worker を通らないため false 固定）。
export const prerender = false;

interface VersionMetadata {
  id: string;
  tag?: string;
}

interface HealthBindings {
  CF_VERSION_METADATA?: VersionMetadata;
}

/**
 * 応答に自分のバージョンを含める。
 *
 * デプロイ直後の疎通確認は、200 が返るだけでは「新しい版が配信されている」ことの
 * 証明にならない（旧版が生きていても 200 を返す）。CI はこの id とデプロイ結果の
 * バージョン ID を突き合わせて反映を判定する。
 */
export const GET: APIRoute = () => {
  const bindings = env as unknown as HealthBindings;
  const version = bindings.CF_VERSION_METADATA?.id ?? null;

  return new Response(JSON.stringify({ status: 'ok', version }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
};
