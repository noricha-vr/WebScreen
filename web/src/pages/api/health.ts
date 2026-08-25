import type { APIRoute } from 'astro';

// SSR 経路の疎通確認用。middleware が付ける COOP/COEP の実測点も兼ねる
// （prerender=true だと静的化され Worker を通らないため false 固定）。
export const prerender = false;

export const GET: APIRoute = () =>
  new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
