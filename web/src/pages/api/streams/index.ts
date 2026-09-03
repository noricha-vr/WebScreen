import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createStream } from '../../../lib/services/streams';
import {
  isStreamStartToken,
  MAX_CREATE_STREAM_BODY_BYTES,
  STREAM_START_TOKEN_HEADER,
} from '../../../lib/contracts/streams';
import { readLimitedJsonBody } from '../../../lib/services/upload-request';
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
    if (!createRequest.ok) return json(createRequest.error, createRequest.status);
    return json(await createStream({ ...context, startToken, reuseId: createRequest.value.id }), 201);
  });

async function parseCreateRequest(request: Request) {
  const contentType = request.headers.get('content-type');
  // Body なしの既存クライアントは従来の新規発行として扱う。ブラウザの fetch は body なし POST にも
  // content-length: 0 を付け、workerd ではその request.body が null にならないため長さでも判定する。
  const isEmptyBody = request.body === null || request.headers.get('content-length') === '0';
  if (contentType === null && isEmptyBody) return { ok: true as const, value: {} };
  if (!isJsonContentType(contentType)) {
    return { ok: false as const, status: 400 as const, error: {
      errorCode: ERROR_CODES.invalidRequest,
      message: 'Content-Type は application/json である必要があります',
    } };
  }
  const body = await readLimitedJsonBody(request, MAX_CREATE_STREAM_BODY_BYTES, { emptyValue: {} });
  if (!body.ok) return body;
  const validated = validateCreateStreamRequest(body.value);
  return validated.ok ? validated : { ...validated, status: 400 as const };
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}
