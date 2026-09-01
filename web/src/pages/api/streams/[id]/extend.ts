import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { extendStream } from '../../../../lib/services/streams';
import {
  json,
  requireStreamId,
  runStreamApi,
  type StreamApiBindings,
} from '../../../../lib/services/stream-api';

export const prerender = false;

/** 延長期限を更新し、新しい publish JWT を発行する。 */
export const POST: APIRoute = ({ request, params }) =>
  runStreamApi(request, env as unknown as StreamApiBindings, async (context) =>
    json(await extendStream({ ...context, id: requireStreamId(params.id) }))
  );
