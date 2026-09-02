import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { ERROR_CODES } from '../../../lib/contracts/api';
import {
  MAX_CANCEL_STREAM_START_BODY_BYTES,
  parseCancelStreamStartRequest,
} from '../../../lib/contracts/streams';
import { readLimitedJsonBody } from '../../../lib/services/upload-request';
import { cancelStreamStart } from '../../../lib/services/stream-start';
import {
  json,
  noContent,
  runStreamApi,
  type StreamApiBindings,
} from '../../../lib/services/stream-api';

export const prerender = false;

/** 離脱済みの配信開始 token を記録し、同 token の live があれば終了する。 */
export const POST: APIRoute = ({ request }) =>
  runStreamApi(request, env as unknown as StreamApiBindings, async (context) => {
    if (!isJsonContentType(request.headers.get('content-type'))) {
      return json(
        { errorCode: ERROR_CODES.invalidRequest, message: 'Content-Type は application/json である必要があります' },
        400
      );
    }
    const body = await readLimitedJsonBody(request, MAX_CANCEL_STREAM_START_BODY_BYTES);
    if (!body.ok) return json(body.error, body.status);
    const validated = parseCancelStreamStartRequest(body.value);
    if (!validated) {
      return json({ errorCode: ERROR_CODES.invalidRequest, message: 'startToken が不正です' }, 400);
    }
    await cancelStreamStart({
      database: context.database,
      userId: context.userId,
      startToken: validated.startToken,
    });
    return noContent();
  });

function isJsonContentType(value: string | null): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}
