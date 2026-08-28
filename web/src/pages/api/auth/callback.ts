import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { ERROR_CODES, type ErrorResponse } from '../../../lib/contracts/api';
import { logWorkerFailure } from '../../../lib/infra/worker-log';
import { resolveLocale } from '../../../i18n';
import {
  OAUTH_STATE_COOKIE_NAME,
  SESSION_COOKIE_ATTRIBUTES,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  importSigningKey,
} from '../../../lib/contracts/session';
import {
  OAuthUpstreamError,
  completeDiscordOAuth,
  consumeOAuthState,
  type AuthDatabase,
} from '../../../lib/services/auth';

export const prerender = false;

interface CallbackBindings {
  DB: AuthDatabase;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  SESSION_SIGNING_KEY: string;
}

/** OAuth state を使い捨て検証し、Discord ユーザーとセッションを確立する。 */
export const GET: APIRoute = async ({ cookies, redirect, request, url }) => {
  const bindings = env as unknown as CallbackBindings;
  const signingKey = await importSigningKey(bindings.SESSION_SIGNING_KEY);
  const callbackState = url.searchParams.get('state') ?? '';
  const validState = await consumeOAuthState(
    () => {
      const value = cookies.get(OAUTH_STATE_COOKIE_NAME)?.value;
      cookies.delete(OAUTH_STATE_COOKIE_NAME, { path: '/' });
      return value;
    },
    callbackState,
    signingKey
  );

  if (!validState) {
    return jsonError(400, ERROR_CODES.invalidRequest, 'OAuth state が不正です');
  }

  const code = url.searchParams.get('code');
  if (!code) return jsonError(400, ERROR_CODES.invalidRequest, '認可 code がありません');

  try {
    const redirectUri = `${url.origin}/api/auth/callback/`;
    const result = await completeDiscordOAuth(code, redirectUri, {
      clientId: bindings.DISCORD_CLIENT_ID,
      clientSecret: bindings.DISCORD_CLIENT_SECRET,
      db: bindings.DB,
      signingKey,
    });
    cookies.set(SESSION_COOKIE_NAME, result.sessionCookieValue, {
      ...SESSION_COOKIE_ATTRIBUTES,
      maxAge: SESSION_TTL_SECONDS,
    });
    return redirect(`/${resolveLocale(request.headers.get('accept-language'))}/`, 302);
  } catch (error) {
    if (error instanceof OAuthUpstreamError) {
      logWorkerFailure({ event: 'oauth_upstream_request_failed', errorCode: ERROR_CODES.internalError, status: 502 });
      return jsonError(502, ERROR_CODES.internalError, 'Discord API への接続に失敗しました');
    }
    logWorkerFailure({ event: 'oauth_callback_failed', errorCode: ERROR_CODES.internalError, status: 500 });
    return jsonError(500, ERROR_CODES.internalError, 'ログイン処理に失敗しました');
  }
};

function jsonError(status: number, errorCode: ErrorResponse['errorCode'], message: string): Response {
  const body: ErrorResponse = { errorCode, message };
  return Response.json(body, { status });
}
