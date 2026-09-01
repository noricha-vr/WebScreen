import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { getStreamStatus } from '../../../../lib/services/streams';
import {
  json,
  requireStreamId,
  runStreamApi,
  type StreamApiBindings,
} from '../../../../lib/services/stream-api';

export const prerender = false;

/** 所有する配信セッションの状態を返す。 */
export const GET: APIRoute = ({ request, params }) =>
  runStreamApi(request, env as unknown as StreamApiBindings, async (context) =>
    json(
      await getStreamStatus({
        database: context.database,
        userId: context.userId,
        id: requireStreamId(params.id),
      })
    )
  );
