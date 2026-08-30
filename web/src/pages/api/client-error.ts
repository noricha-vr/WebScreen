import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { importSigningKey } from '../../lib/contracts/session';
import { handleClientErrorReport } from '../../lib/services/client-error';

export const prerender = false;

interface ClientErrorBindings {
  SESSION_SIGNING_KEY?: string;
}

/**
 * ブラウザ内で完結した失敗の報告を受ける。認証は任意（未ログインの失敗も数えたい）。
 *
 * 応答は常に 204 か 400 で、報告者へは何も返さない（beacon の投げっぱなしを前提にする）。
 */
export const POST: APIRoute = async ({ request }) => {
  const bindings = env as unknown as ClientErrorBindings;
  const signingKey = bindings.SESSION_SIGNING_KEY
    ? await importSigningKey(bindings.SESSION_SIGNING_KEY)
    : undefined;

  return handleClientErrorReport(request, { signingKey });
};
