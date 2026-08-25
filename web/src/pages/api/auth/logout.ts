import type { APIRoute } from 'astro';

import { SESSION_COOKIE_NAME } from '../../../lib/contracts/session';

export const prerender = false;

/** ログインセッション Cookie を破棄する。 */
export const POST: APIRoute = ({ cookies }) => {
  cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
  return new Response(null, { status: 204 });
};
