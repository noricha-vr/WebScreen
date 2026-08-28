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
  if (!movie) return notFound();

  const object = await bindings.BUCKET.get(movieKey(movie.shortId));
  if (!object?.body) return notFound();

  return new Response(object.body, {
    status: 200,
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Disposition': attachmentDisposition(movie.filename),
      // cdn 側の Transform Rule はこの経路に効かないため、ここで明示する。
      'X-Robots-Tag': 'noindex',
      // 同じ動画への連続アクセスをエッジで吸収しつつ、削除後に配信され続ける窓は
      // 短く抑える（cdn 直の既定 TTL 120 分より大幅に短い）。
      'Cache-Control': 'public, max-age=300',
    },
  });
};

/** 存在しない・未完成の動画。ready へ変わった後も 404 が残らないようキャッシュさせない。 */
function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}
