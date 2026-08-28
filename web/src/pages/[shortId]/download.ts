import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { movieKey } from '../../lib/contracts/r2key';
import { findPublicMovie, type MoviesDatabase } from '../../lib/services/movies';
import { attachmentDisposition } from '../../lib/services/download';

export const prerender = false;

interface DownloadBucket {
  get(key: string): Promise<{ body: ReadableStream | null; size?: number } | null>;
}

interface DownloadBindings {
  DB: MoviesDatabase;
  BUCKET: DownloadBucket;
  R2_PUBLIC_BASE_URL: string;
}

/**
 * 動画をダウンロードとして返す。
 *
 * 配信ドメイン（cdn）はページと別オリジンなので、`<a download>` はブラウザに
 * 無視されて再生が始まってしまう。R2 側に Content-Disposition を常時付けると
 * VRChat の直接再生を壊すため、ダウンロードのときだけ Worker で中継して付ける。
 * 本文は R2 のストリームをそのまま流すので、Worker のメモリは消費しない。
 *
 * 動画そのものが公開なので、この経路も認証しない（所有者以外もダウンロードできる）。
 */
export const GET: APIRoute = async ({ params }) => {
  const bindings = env as unknown as DownloadBindings;
  const shortId = params.shortId ?? '';

  const movie = await findPublicMovie({
    database: bindings.DB,
    shortId,
    publicBaseUrl: bindings.R2_PUBLIC_BASE_URL,
  });
  if (!movie) return new Response(null, { status: 404 });

  const object = await bindings.BUCKET.get(movieKey(movie.shortId));
  if (!object?.body) return new Response(null, { status: 404 });

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Disposition': attachmentDisposition(movie.filename),
      // 保管期限つきの実体を CDN に長く持たせない（削除後の配信を短く抑える）。
      'Cache-Control': 'private, max-age=0, must-revalidate',
    },
  });
};
