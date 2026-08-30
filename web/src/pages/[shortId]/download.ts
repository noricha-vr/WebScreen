import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { movieKey } from '../../lib/contracts/r2key';
import { findPublicMovie, type MoviesDatabase } from '../../lib/services/movies';
import {
  downloadHeaders,
  partialContentRange,
  resolveRangeRequest,
  unsatisfiedContentRange,
} from '../../lib/services/download';

export const prerender = false;

interface DownloadBucket {
  head(key: string): Promise<{ size: number } | null>;
  get(
    key: string,
    options?: { range: { offset: number; length: number } }
  ): Promise<{ body: ReadableStream | null; size: number } | null>;
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
export const GET: APIRoute = async ({ params, request }) => {
  const bindings = env as unknown as DownloadBindings;
  const shortId = params.shortId ?? '';

  const movie = await findPublicMovie({
    database: bindings.DB,
    shortId,
    publicBaseUrl: bindings.R2_PUBLIC_BASE_URL,
  });
  if (!movie) return notFound();

  const key = movieKey(movie.shortId);
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader === null) return await fullResponse(bindings.BUCKET, key, movie.filename);

  // 総量は範囲の確定にも 416 の Content-Range にも要るので、本文を取りに行く前に
  // メタデータだけ引く（実体を読まないので Range 要求のときしか払わない）。
  const head = await bindings.BUCKET.head(key);
  if (!head) return notFound();

  const resolved = resolveRangeRequest(rangeHeader, head.size);
  if (resolved.kind === 'unsatisfiable') return rangeNotSatisfiable(head.size);
  if (resolved.kind === 'full') return await fullResponse(bindings.BUCKET, key, movie.filename);

  const object = await bindings.BUCKET.get(key, {
    range: { offset: resolved.offset, length: resolved.length },
  });
  if (!object?.body) return notFound();

  return new Response(object.body, {
    status: 206,
    headers: downloadHeaders({
      filename: movie.filename,
      contentLength: resolved.length,
      contentRange: partialContentRange(resolved, head.size),
    }),
  });
};

/** 全体を 200 で返す。Range 無しと、範囲を無視した（未知の単位・複数レンジ）場合の経路。 */
async function fullResponse(
  bucket: DownloadBucket,
  key: string,
  filename: string
): Promise<Response> {
  const object = await bucket.get(key);
  if (!object?.body) return notFound();

  return new Response(object.body, {
    status: 200,
    headers: downloadHeaders({ filename, contentLength: object.size }),
  });
}

/** 存在しない・未完成の動画。ready へ変わった後も 404 が残らないようキャッシュさせない。 */
function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}

/** 要求された範囲が実体と重ならない。総量を返して要求し直せるようにする。 */
function rangeNotSatisfiable(size: number): Response {
  return new Response(null, {
    status: 416,
    headers: {
      'Content-Range': unsatisfiedContentRange(size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
  });
}
