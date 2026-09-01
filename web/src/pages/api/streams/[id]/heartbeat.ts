import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { heartbeatStream } from '../../../../lib/services/streams';
import {
  noContent,
  requireStreamId,
  runStreamApi,
  type StreamApiBindings,
} from '../../../../lib/services/stream-api';

export const prerender = false;

/** 所有する live セッションの heartbeat を更新する。 */
export const POST: APIRoute = ({ request, params }) =>
  runStreamApi(request, env as unknown as StreamApiBindings, async (context) => {
    await heartbeatStream({
      database: context.database,
      userId: context.userId,
      id: requireStreamId(params.id),
    });
    return noContent();
  });
