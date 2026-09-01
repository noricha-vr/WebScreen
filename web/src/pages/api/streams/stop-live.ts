import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { stopAllLiveStreams } from '../../../lib/services/streams';
import {
  json,
  runStreamApi,
  type StreamApiBindings,
} from '../../../lib/services/stream-api';

export const prerender = false;

/** 所有する live 配信をすべて終了し、再作成までの待機秒数を返す。 */
export const POST: APIRoute = ({ request }) =>
  runStreamApi(request, env as unknown as StreamApiBindings, async (context) =>
    json(await stopAllLiveStreams(context))
  );
