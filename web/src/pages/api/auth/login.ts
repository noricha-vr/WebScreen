import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import {
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_SECONDS,
  SESSION_COOKIE_ATTRIBUTES,
  importSigningKey,
} from '../../../lib/contracts/session';
import { buildDiscordLoginUrl, createOAuthState } from '../../../lib/services/auth';

export const prerender = false;

interface LoginBindings {
  DISCORD_CLIENT_ID: string;
  SESSION_SIGNING_KEY: string;
}

/** Discord OAuth を開始し、署名付き state Cookie と認可リダイレクトを返す。 */
export const GET: APIRoute = async ({ cookies, redirect, url }) => {
  const bindings = env as unknown as LoginBindings;
  const signingKey = await importSigningKey(bindings.SESSION_SIGNING_KEY);
  const oauthState = await createOAuthState(signingKey);
  cookies.set(OAUTH_STATE_COOKIE_NAME, oauthState.cookieValue, {
    ...SESSION_COOKIE_ATTRIBUTES,
    maxAge: OAUTH_STATE_TTL_SECONDS,
  });

  const redirectUri = `${url.origin}/api/auth/callback/`;
  return redirect(
    buildDiscordLoginUrl(bindings.DISCORD_CLIENT_ID, redirectUri, oauthState.state),
    302
  );
};
