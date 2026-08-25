import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { importSigningKey } from '../../lib/contracts/session';
import { proxyCapture, type CaptureBindings } from '../../lib/services/capture';

export const prerender = false;

interface WorkerCaptureBindings {
  DB: CaptureBindings['database'];
  SESSION_SIGNING_KEY: string;
  WEBCAPTURE_URL: string;
  WEBCAPTURE_TOKEN: string;
}

/** web-capture サービスへ認証済みのスクリーンショット要求を転送する。 */
export const POST: APIRoute = async ({ request }) => {
  const bindings = env as unknown as WorkerCaptureBindings;
  const signingKey = await importSigningKey(bindings.SESSION_SIGNING_KEY);
  return proxyCapture(request, {
    database: bindings.DB,
    signingKey,
    webCaptureUrl: bindings.WEBCAPTURE_URL,
    webCaptureToken: bindings.WEBCAPTURE_TOKEN,
  });
};
