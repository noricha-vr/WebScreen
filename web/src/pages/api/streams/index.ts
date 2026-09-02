import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createStream } from '../../../lib/services/streams';
import {
  isStreamStartToken,
  STREAM_START_TOKEN_HEADER,
} from '../../../lib/contracts/streams';
import { ERROR_CODES } from '../../../lib/contracts/api';
import {
  json,
  runStreamApi,
  type StreamApiBindings,
} from '../../../lib/services/stream-api';

export const prerender = false;

/** 新しい配信セッションと publish JWT を発行する。 */
export const POST: APIRoute = ({ request }) =>
  runStreamApi(request, env as unknown as StreamApiBindings, async (context) => {
    const startToken = request.headers.get(STREAM_START_TOKEN_HEADER);
    if (startToken !== null && !isStreamStartToken(startToken)) {
      return json(
        { errorCode: ERROR_CODES.invalidRequest, message: '配信開始 token が不正です' },
        400
      );
    }
    return json(await createStream({ ...context, startToken }), 201);
  });
