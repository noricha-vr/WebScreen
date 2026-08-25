import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { ERROR_CODES } from '../../../../lib/contracts/api';
import { importSigningKey } from '../../../../lib/contracts/session';
import { requireUser, type AuthDatabase } from '../../../../lib/services/auth';
import {
  deleteMovie,
  MovieActionError,
  type MovieBucket,
  type MoviesDatabase,
} from '../../../../lib/services/movies';

export const prerender = false;

interface DeleteBindings {
  DB: AuthDatabase & MoviesDatabase;
  BUCKET: MovieBucket;
  SESSION_SIGNING_KEY: string;
}

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
