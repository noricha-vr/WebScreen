import type { MiddlewareHandler } from 'astro';

/**
 * COOP/COEP を SSR / server endpoint のレスポンスに付与する。
 *
 * public/_headers は Static Assets の配信にしか適用されず、Worker が生成した
 * レスポンス（prerender=false のページ・API ルート）には効かない。
 * FFmpeg.wasm の SharedArrayBuffer は crossOriginIsolated を要求するため、
 * 静的・動的の両経路で同じヘッダーを配る必要がある（_headers と本ファイルの二重化）。
 */
const CROSS_ORIGIN_ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export const onRequest: MiddlewareHandler = async (_context, next) => {
  const response = await next();

  for (const [name, value] of Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS)) {
    response.headers.set(name, value);
  }

  return response;
};
