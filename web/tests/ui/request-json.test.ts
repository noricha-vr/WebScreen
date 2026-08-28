import { describe, expect, test } from 'bun:test';

import { isUnauthorizedRequestError, JsonRequestError, requestJson } from '../../src/lib/ui/request-json';

function respondWith(body: string, init: ResponseInit = {}): typeof fetch {
  return (async () => new Response(body, init)) as unknown as typeof fetch;
}

describe('requestJson', () => {
  test('成功応答の JSON をそのまま返す', async () => {
    const fetchImpl = respondWith('{"movies":[]}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    expect(await requestJson('/api/history/', {}, fetchImpl)).toEqual({ movies: [] });
  });

  test('本文が空の成功応答は null を返す（204 の削除など）', async () => {
    const fetchImpl = respondWith('', { status: 204 });

    expect(await requestJson('/api/movies/AbCdEf123456/', { method: 'DELETE' }, fetchImpl)).toBeNull();
  });

  test('成功応答が JSON でなければ失敗として投げる', async () => {
    // 200 のまま null を返すと、呼び出し側が「0 件の結果」と誤認する（履歴が空表示になる）。
    const fetchImpl = respondWith('<html>proxy error</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });

    expect(requestJson('/api/history/', {}, fetchImpl)).rejects.toBeInstanceOf(JsonRequestError);
  });

  test('エラー応答は status と errorCode を保持して投げる', async () => {
    const fetchImpl = respondWith('{"errorCode":"PAGE_TOO_LONG","message":"..."}', {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });

    const error = await requestJson('/api/capture/', { method: 'POST' }, fetchImpl).catch((thrown) => thrown);

    expect(error).toBeInstanceOf(JsonRequestError);
    expect((error as JsonRequestError).status).toBe(400);
    expect((error as JsonRequestError).errorCode).toBe('PAGE_TOO_LONG');
  });

  test('エラー応答が JSON でなくても status は保持する', async () => {
    const fetchImpl = respondWith('gateway timeout', { status: 504 });

    const error = await requestJson('/api/capture/', { method: 'POST' }, fetchImpl).catch((thrown) => thrown);

    expect((error as JsonRequestError).status).toBe(504);
    expect((error as JsonRequestError).errorCode).toBeNull();
  });

  test('401 とエラーコードのどちらからでも認証切れを判定できる', () => {
    expect(isUnauthorizedRequestError(new JsonRequestError(401, null))).toBe(true);
    expect(isUnauthorizedRequestError(new JsonRequestError(500, 'UNAUTHORIZED'))).toBe(true);
    expect(isUnauthorizedRequestError(new JsonRequestError(500, 'INTERNAL_ERROR'))).toBe(false);
    expect(isUnauthorizedRequestError(new Error('boom'))).toBe(false);
  });
});
