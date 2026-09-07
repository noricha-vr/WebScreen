import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { streamJwksResponse } from '../../../lib/services/stream-api';

export const prerender = false;

interface JwksBindings {
  STREAM_JWT_PRIVATE_KEY: string;
  /** ちょいキャスの JWKS URL。cutover までの一時設定（wrangler.jsonc の vars）。 */
  STREAM_JWKS_MERGE_URL?: string;
}

/** MediaMTX が publish JWT を検証するための公開 JWKS を返す。 */
export const GET: APIRoute = async () => {
  const bindings = env as unknown as JwksBindings;
  return streamJwksResponse(bindings.STREAM_JWT_PRIVATE_KEY, bindings.STREAM_JWKS_MERGE_URL);
};
