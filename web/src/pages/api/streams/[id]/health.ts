import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { getStreamHealth } from '../../../../lib/services/stream-health';
import { createStreamMediaMtxClients } from '../../../../lib/services/stream-media';
import {
  json,
  requireStreamId,
  runStreamApi,
  type StreamApiBindings,
} from '../../../../lib/services/stream-api';

export const prerender = false;

interface StreamHealthBindings extends StreamApiBindings {
  MEDIAMTX_API_URL?: string;
  MEDIAMTX_API_TOKEN?: string;
  MEDIAMTX_INGRESS_API_URL?: string;
  MEDIAMTX_INGRESS_API_TOKEN?: string;
  MEDIAMTX_EGRESS_API_URL?: string;
  MEDIAMTX_EGRESS_API_TOKEN?: string;
}

/** 所有者向けに二段 relay の ingest 到達状態を返す。 */
export const GET: APIRoute = ({ request, params }) => {
  const bindings = env as unknown as StreamHealthBindings;
  return runStreamApi(request, bindings, async (context) => {
    const mediaMtx = createStreamMediaMtxClients({
      legacyApiUrl: bindings.MEDIAMTX_API_URL,
      legacyApiToken: bindings.MEDIAMTX_API_TOKEN,
      ingressApiUrl: bindings.MEDIAMTX_INGRESS_API_URL,
      ingressApiToken: bindings.MEDIAMTX_INGRESS_API_TOKEN,
      egressApiUrl: bindings.MEDIAMTX_EGRESS_API_URL,
      egressApiToken: bindings.MEDIAMTX_EGRESS_API_TOKEN,
    });
    if (!mediaMtx) throw new Error('MediaMTX health configuration is required');
    return json(
      await getStreamHealth({
        database: context.database,
        userId: context.userId,
        id: requireStreamId(params.id),
        ...mediaMtx,
      })
    );
  });
};
