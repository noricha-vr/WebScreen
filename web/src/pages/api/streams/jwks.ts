import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { streamJwksResponse } from '../../../lib/services/stream-api';

export const prerender = false;

interface JwksBindings {
  STREAM_JWT_PRIVATE_KEY: string;
}

/** MediaMTX が publish JWT を検証するための公開 JWKS を返す。 */
export const GET: APIRoute = async () => {
  return streamJwksResponse((env as unknown as JwksBindings).STREAM_JWT_PRIVATE_KEY);
};
