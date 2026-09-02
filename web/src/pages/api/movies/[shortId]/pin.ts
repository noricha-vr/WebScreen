import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { ERROR_CODES } from '../../../../lib/contracts/api';
import { logWorkerFailure } from '../../../../lib/observability/worker-log';
import { importSigningKey } from '../../../../lib/contracts/session';
import { requireUser, type AuthDatabase } from '../../../../lib/services/auth';
import { MovieActionError, togglePin, type MoviesDatabase } from '../../../../lib/services/movies';

export const prerender = false;

interface PinBindings {
  DB: AuthDatabase & MoviesDatabase;
  SESSION_SIGNING_KEY: string;
}

/** 所有者の動画の pin を切り替える（pin 中は保管期限が 1 年後まで延びる）。 */
export const POST: APIRoute = async ({ request, params }) => {
  const bindings = env as unknown as PinBindings;
  const signingKey = await importSigningKey(bindings.SESSION_SIGNING_KEY);
  const result = await requireUser(request, { db: bindings.DB, signingKey });
  if (!result.ok) return Response.json(result.error, { status: result.status });

  try {
    const response = await togglePin({
      database: bindings.DB,
      userId: result.user.id,
      shortId: params.shortId ?? '',
    });
    return Response.json(response);
  } catch (error) {
    if (error instanceof MovieActionError) {
      return Response.json(
        { errorCode: error.errorCode, message: error.message },
        { status: error.status }
      );
    }
    logWorkerFailure({ event: 'movie_pin_failed', errorCode: ERROR_CODES.internalError, status: 500 });
    return Response.json(
      { errorCode: ERROR_CODES.internalError, message: 'ピン留めを変更できませんでした' },
      { status: 500 }
    );
  }
};
