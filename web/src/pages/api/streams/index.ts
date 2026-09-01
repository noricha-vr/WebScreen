import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createStream } from '../../../lib/services/streams';
import {
  json,
  runStreamApi,
  type StreamApiBindings,
} from '../../../lib/services/stream-api';

export const prerender = false;

/** 新しい配信セッションと publish JWT を発行する。 */
export const POST: APIRoute = ({ request }) =>
  runStreamApi(request, env as unknown as StreamApiBindings, async (context) =>
    json(await createStream(context), 201)
  );
