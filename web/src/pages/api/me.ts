import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { importSigningKey } from '../../lib/contracts/session';
import { requireUser, type AuthDatabase } from '../../lib/services/auth';

export const prerender = false;

interface MeBindings {
  DB: AuthDatabase;
  SESSION_SIGNING_KEY: string;
}

/** ログイン中の Discord ユーザーを返す。 */
export const GET: APIRoute = async ({ request }) => {
  const bindings = env as unknown as MeBindings;
  const signingKey = await importSigningKey(bindings.SESSION_SIGNING_KEY);
  const result = await requireUser(request, {
    db: bindings.DB,
    signingKey,
  });

  const headers = { 'Cache-Control': 'no-store' };
  if (!result.ok) return Response.json(result.error, { status: result.status, headers });
  return Response.json(result.user, { headers });
};
