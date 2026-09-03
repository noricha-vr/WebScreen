import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createStream } from '../../../lib/services/streams';
import {
  isStreamStartToken,
  STREAM_START_TOKEN_HEADER,
} from '../../../lib/contracts/streams';
import { ERROR_CODES, validateCreateStreamRequest } from '../../../lib/contracts/api';
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
    const createRequest = await parseCreateRequest(request);
    if (!createRequest.ok) return json(createRequest.error, 400);
    return json(await createStream({ ...context, startToken, reuseId: createRequest.value.id }), 201);
  });

async function parseCreateRequest(request: Request) {
  // Body なしの既存クライアントは従来の新規発行として扱う。
  if (request.body === null) return validateCreateStreamRequest({});
  try {
    return validateCreateStreamRequest(await request.json());
  } catch {
    return validateCreateStreamRequest(null);
  }
}
