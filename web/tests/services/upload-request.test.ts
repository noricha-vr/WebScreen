import { describe, expect, test } from 'bun:test';

import { ERROR_CODES, MAX_ABANDON_UPLOAD_BODY_BYTES } from '../../src/lib/contracts/api';
import { readLimitedJsonBody } from '../../src/lib/services/upload-request';

function request(body: string, contentLength?: string): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (contentLength !== undefined) headers.set('content-length', contentLength);
  return new Request('https://web-screen.net/api/uploads/abandon/', {
    method: 'POST',
    headers,
    body,
  });
}

describe('readLimitedJsonBody', () => {
  test('Content-Length が abandon 上限を超えれば本文を読まず 413 にする', async () => {
    const result = await readLimitedJsonBody(
      request('{}', String(MAX_ABANDON_UPLOAD_BODY_BYTES + 1)),
      MAX_ABANDON_UPLOAD_BODY_BYTES
    );

    expect(result).toMatchObject({
      ok: false,
      status: 413,
      error: { errorCode: ERROR_CODES.payloadTooLarge },
    });
  });

  test('偽装 Content-Length でも実バイトが上限を超えれば 413 にする', async () => {
    const oversized = JSON.stringify({ shortId: 'AbCdEf123456', padding: 'x'.repeat(5_000) });
    const result = await readLimitedJsonBody(
      request(oversized, '10'),
      MAX_ABANDON_UPLOAD_BODY_BYTES
    );

    expect(result).toMatchObject({
      ok: false,
      status: 413,
      error: { errorCode: ERROR_CODES.payloadTooLarge },
    });
  });

  test('壊れた JSON は INVALID_REQUEST の 400 にする', async () => {
    const result = await readLimitedJsonBody(
      request('{'),
      MAX_ABANDON_UPLOAD_BODY_BYTES
    );

    expect(result).toMatchObject({
      ok: false,
      status: 400,
      error: { errorCode: ERROR_CODES.invalidRequest },
    });
  });
});
