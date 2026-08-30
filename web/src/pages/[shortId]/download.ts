import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { movieKey } from '../../lib/contracts/r2key';
import { findPublicMovie, type MoviesDatabase } from '../../lib/services/movies';
import {
  downloadHeaders,
  partialContentRange,
  rangeApplies,
  resolveRangeRequest,
  unsatisfiedContentRange,
} from '../../lib/services/download';

export const prerender = false;

interface DownloadObject {
  body: ReadableStream | null;
  size: number;
  httpEtag: string;
}

interface DownloadBucket {
  /** `etag` は引用符なし、`httpEtag` は引用符付き。用途が違うので両方使う。 */
  head(key: string): Promise<{ size: number; etag: string; httpEtag: string } | null>;
  get(
    key: string,
    options?: {
      range: { offset: number; length: number };
      onlyIf: { etagMatches: string };
    }
  ): Promise<DownloadObject | null>;
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

  const movie = await findMovie(bindings, params.shortId ?? '');
  if (!movie) return notFound();

  const key = movieKey(movie.shortId);
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader === null) return await fullResponse(bindings.BUCKET, key, movie.filename);

  // 総量は範囲の確定にも 416 の Content-Range にも要るので、本文を取りに行く前に
  // メタデータだけ引く（実体を読まないので Range 要求のときしか払わない）。
  const head = await bindings.BUCKET.head(key);
  if (!head) return notFound();

  // 中断前と実体が変わっていたら、続きを継ぎ足しても壊れたファイルにしかならない
  if (!rangeApplies(request.headers.get('If-Range'), head.httpEtag)) {
    return await fullResponse(bindings.BUCKET, key, movie.filename);
  }

  const resolved = resolveRangeRequest(rangeHeader, head.size);
  if (resolved.kind === 'unsatisfiable') return rangeNotSatisfiable(head.size);
  if (resolved.kind === 'full') return await fullResponse(bindings.BUCKET, key, movie.filename);

  const object = await bindings.BUCKET.get(key, {
    range: { offset: resolved.offset, length: resolved.length },
    // head と get の間で差し替わると、別の実体の断片を返してしまう。
    // 条件に渡す etag は引用符なし（httpEtag を渡すと R2 が TypeError を投げる）
    onlyIf: { etagMatches: head.etag },
  });
  if (!object) return notFound();
  // 条件が外れた時は本文が付かない。総量も変わっているので全体を取り直す
  if (!object.body) return await fullResponse(bindings.BUCKET, key, movie.filename);

  return new Response(object.body, {
    status: 206,
    headers: downloadHeaders({
      filename: movie.filename,
      contentLength: resolved.length,
      etag: object.httpEtag,
      contentRange: partialContentRange(resolved, head.size),
    }),
  });
};

/**
 * 本文を伴わないメタデータの問い合わせ。
 *
 * 明示しないと Astro が GET を呼んで本文だけ捨てるため、Range 付きの HEAD に
 * 206 と Content-Range を返してしまう（RFC 9110 14.2 は GET 以外の Range を無視させる）。
 */
export const HEAD: APIRoute = async ({ params }) => {
  const bindings = env as unknown as DownloadBindings;

  const movie = await findMovie(bindings, params.shortId ?? '');
  if (!movie) return notFound();

  const head = await bindings.BUCKET.head(movieKey(movie.shortId));
  if (!head) return notFound();

  return new Response(null, {
    status: 200,
    headers: downloadHeaders({
      filename: movie.filename,
      contentLength: head.size,
      etag: head.httpEtag,
    }),
  });
};

/** 公開中の動画を引く。GET と HEAD で 404 の条件を揃える。 */
async function findMovie(bindings: DownloadBindings, shortId: string) {
  return await findPublicMovie({
    database: bindings.DB,
    shortId,
    publicBaseUrl: bindings.R2_PUBLIC_BASE_URL,
  });
}

/** 全体を 200 で返す。Range 無しと、範囲を無視した（未知の単位・複数レンジ・If-Range 不一致）場合の経路。 */
async function fullResponse(
  bucket: DownloadBucket,
  key: string,
  filename: string
): Promise<Response> {
  const object = await bucket.get(key);
  if (!object?.body) return notFound();

  return new Response(object.body, {
    status: 200,
    headers: downloadHeaders({
      filename,
      contentLength: object.size,
      etag: object.httpEtag,
    }),
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
