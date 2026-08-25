import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { importSigningKey } from '../../lib/contracts/session';
import { requireUser, type AuthDatabase } from '../../lib/services/auth';
import { listHistory, type MoviesDatabase } from '../../lib/services/movies';

export const prerender = false;

interface HistoryBindings {
  DB: AuthDatabase & MoviesDatabase;
  SESSION_SIGNING_KEY: string;
  R2_PUBLIC_BASE_URL: string;
}

/** ログイン中のユーザー自身の動画一覧を返す。 */
export const GET: APIRoute = async ({ request }) => {
  const bindings = env as unknown as HistoryBindings;
  const signingKey = await importSigningKey(bindings.SESSION_SIGNING_KEY);
  const result = await requireUser(request, { db: bindings.DB, signingKey });
  if (!result.ok) return Response.json(result.error, { status: result.status });

  const history = await listHistory({
    database: bindings.DB,
    userId: result.user.id,
    publicBaseUrl: bindings.R2_PUBLIC_BASE_URL,
  });

  // 本人限定の一覧なので、共有キャッシュに載せない。
  return Response.json(history, { headers: { 'Cache-Control': 'no-store' } });
};
