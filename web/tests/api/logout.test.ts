import { describe, expect, test } from 'bun:test';

import { POST } from '../../src/pages/api/auth/logout';

/** ログアウトハンドラを最小のモック context で直接叩く。 */
async function callLogout(body: string | null): Promise<{
  status: number;
  location: string | null;
  deletedCookies: string[];
}> {
  const deletedCookies: string[] = [];
  const request = new Request('http://localhost/api/auth/logout/', {
    method: 'POST',
    headers: body === null ? {} : { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const context = {
    request,
    cookies: {
      delete: (name: string) => {
        deletedCookies.push(name);
      },
    },
    redirect: (location: string, status: number) =>
      new Response(null, { status, headers: { location } }),
  };

  const response = await POST(context as unknown as Parameters<typeof POST>[0]);
  return { status: response.status, location: response.headers.get('location'), deletedCookies };
}

describe('POST /api/auth/logout/', () => {
  test('lang=ja なら /ja/ へ 303 リダイレクトし Cookie を破棄する', async () => {
    const result = await callLogout('lang=ja');
    expect(result.status).toBe(303);
    expect(result.location).toBe('/ja/');
    expect(result.deletedCookies).toEqual(['ws_session']);
  });

  test('lang=en なら /en/ へ 303 リダイレクトする', async () => {
    const result = await callLogout('lang=en');
    expect(result.status).toBe(303);
    expect(result.location).toBe('/en/');
  });

  test('lang が不正値なら既定の /ja/ にフォールバックする', async () => {
    const result = await callLogout('lang=https%3A%2F%2Fevil.example');
    expect(result.status).toBe(303);
    expect(result.location).toBe('/ja/');
  });

  test('form body が無くても /ja/ に 303 で戻り Cookie は破棄される', async () => {
    const result = await callLogout(null);
    expect(result.status).toBe(303);
    expect(result.location).toBe('/ja/');
    expect(result.deletedCookies).toEqual(['ws_session']);
  });
});
