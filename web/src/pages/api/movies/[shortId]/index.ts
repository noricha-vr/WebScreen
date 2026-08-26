import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { ERROR_CODES } from '../../../../lib/contracts/api';
import { importSigningKey } from '../../../../lib/contracts/session';
import { requireUser, type AuthDatabase } from '../../../../lib/services/auth';
import {
  deleteMovie,
  MovieActionError,
  renameMovie,
  type MovieBucket,
  type MoviesDatabase,
} from '../../../../lib/services/movies';

export const prerender = false;

interface DeleteBindings {
  DB: AuthDatabase & MoviesDatabase;
  BUCKET: MovieBucket;
  SESSION_SIGNING_KEY: string;
}

function invalidRequest(message: string): Response {
  return Response.json({ errorCode: ERROR_CODES.invalidRequest, message }, { status: 400 });
}

/** 所有者の動画の表示名を変更する。 */
export const PATCH: APIRoute = async ({ request, params }) => {
  const bindings = env as unknown as DeleteBindings;
  const signingKey = await importSigningKey(bindings.SESSION_SIGNING_KEY);
  const result = await requireUser(request, { db: bindings.DB, signingKey });
  if (!result.ok) return Response.json(result.error, { status: result.status });

  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return invalidRequest('Content-Type は application/json である必要があります');
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidRequest('リクエストボディは JSON である必要があります');
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return invalidRequest('リクエストボディは JSON オブジェクトである必要があります');
  }

  try {
    const response = await renameMovie({
      database: bindings.DB,
      userId: result.user.id,
      shortId: params.shortId ?? '',
      filename: (body as { filename?: unknown }).filename,
    });
    return Response.json(response);
  } catch (error) {
    if (error instanceof MovieActionError) {
      return Response.json(
        { errorCode: error.errorCode, message: error.message },
        { status: error.status }
      );
    }
    return Response.json(
      { errorCode: ERROR_CODES.internalError, message: 'ファイル名を変更できませんでした' },
      { status: 500 }
    );
  }
};

/** 所有者の動画を R2 と D1 の両方から削除する。 */
export const DELETE: APIRoute = async ({ request, params }) => {
  const bindings = env as unknown as DeleteBindings;
  const signingKey = await importSigningKey(bindings.SESSION_SIGNING_KEY);
  const result = await requireUser(request, { db: bindings.DB, signingKey });
  if (!result.ok) return Response.json(result.error, { status: result.status });

  try {
    await deleteMovie({
      database: bindings.DB,
      bucket: bindings.BUCKET,
      userId: result.user.id,
      shortId: params.shortId ?? '',
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof MovieActionError) {
      return Response.json(
        { errorCode: error.errorCode, message: error.message },
        { status: error.status }
      );
    }
    return Response.json(
      { errorCode: ERROR_CODES.internalError, message: '動画を削除できませんでした' },
      { status: 500 }
    );
  }
};
