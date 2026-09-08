import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { ERROR_CODES } from '../../src/lib/contracts/api';
import { onRequest } from '../../src/middleware';
import { checkMutationOrigin } from '../../src/lib/services/request-origin';

const SITE = 'https://web-screen.net';

interface CallResult {
  response: Response;
  nextCalled: boolean;
}

/** middleware を Astro を介さず直接叩く。context は判定に使うフィールドだけの最小構成。 */
async function callMiddleware(
  request: Request,
  options: { isPrerendered?: boolean } = {}
): Promise<CallResult> {
  let nextCalled = false;
  const next = async (): Promise<Response> => {
    nextCalled = true;
    return new Response('ok', { status: 200 });
  };
  const context = {
    request,
    url: new URL(request.url),
    isPrerendered: options.isPrerendered ?? false,
  };
  const response = await onRequest(
    context as unknown as Parameters<typeof onRequest>[0],
    next as unknown as Parameters<typeof onRequest>[1]
  );
  // MiddlewareHandler の戻り型は void も許すが、本 middleware は常に Response を返す。
  if (!(response instanceof Response)) throw new Error('middleware returned no Response');
  return { response, nextCalled };
}

function jsonRequest(
  method: string,
  path: string,
  headers: Record<string, string> = {}
): Request {
  return new Request(`${SITE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'GET' || method === 'HEAD' ? null : '{}',
  });
}

async function expectForbidden(result: CallResult): Promise<void> {
  expect(result.nextCalled).toBe(false);
  expect(result.response.status).toBe(403);
  expect(result.response.headers.get('cache-control')).toBe('no-store');
  const body = (await result.response.json()) as { errorCode: string; message: string };
  expect(body.errorCode).toBe(ERROR_CODES.forbidden);
  expect(typeof body.message).toBe('string');
}

describe('middleware: 更新系 API の Origin 検証', () => {
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('クロス origin の JSON POST は 403 FORBIDDEN で拒否し、ハンドラに届かない', async () => {
    // Astro 自身の checkOrigin は application/json を素通しするので、ここが唯一の防壁。
    const result = await callMiddleware(
      jsonRequest('POST', '/api/movies/E2EReady0001/pin/', { origin: 'https://evil.example' })
    );

    await expectForbidden(result);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(String(warnSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(entry['event']).toBe('cross_origin_mutation_rejected');
    expect(entry['reason']).toBe('origin_mismatch');
    // ログにリクエストの値（Origin・URL）を残さない。
    expect(JSON.stringify(entry)).not.toContain('evil.example');
  });

  test('兄弟サブドメイン（same-site）からの POST も拒否する', async () => {
    const result = await callMiddleware(
      jsonRequest('POST', '/api/uploads/presign/', { origin: 'https://cdn.web-screen.net' })
    );

    await expectForbidden(result);
  });

  test('Origin が無い更新系リクエストは拒否する（非ブラウザ・古いブラウザ）', async () => {
    const result = await callMiddleware(jsonRequest('DELETE', '/api/movies/E2EReady0001/'));

    await expectForbidden(result);
    const entry = JSON.parse(String(warnSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(entry['reason']).toBe('origin_missing');
  });

  test('Origin: null（サンドボックス iframe・リダイレクト経由）は拒否する', async () => {
    const result = await callMiddleware(
      jsonRequest('POST', '/api/uploads/commit/', { origin: 'null' })
    );

    await expectForbidden(result);
  });

  test('Sec-Fetch-Site: cross-site は Origin が一致していても拒否する', async () => {
    const result = await callMiddleware(
      jsonRequest('POST', '/api/uploads/commit/', { origin: SITE, 'sec-fetch-site': 'cross-site' })
    );

    await expectForbidden(result);
    const entry = JSON.parse(String(warnSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(entry['reason']).toBe('fetch_site_rejected');
  });

  test('Sec-Fetch-Site: same-site は拒否する', async () => {
    const result = await callMiddleware(
      jsonRequest('POST', '/api/uploads/commit/', { origin: SITE, 'sec-fetch-site': 'same-site' })
    );

    await expectForbidden(result);
  });

  test.each(['POST', 'PATCH', 'DELETE'])('同一 origin の %s はハンドラへ通す', async (method) => {
    const result = await callMiddleware(
      jsonRequest(method, '/api/movies/E2EReady0001/', { origin: SITE, 'sec-fetch-site': 'same-origin' })
    );

    expect(result.nextCalled).toBe(true);
    expect(result.response.status).toBe(200);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('Sec-Fetch-Site: same-origin なら Origin 欠落でも通す', async () => {
    const result = await callMiddleware(
      jsonRequest('POST', '/api/uploads/abandon/', { 'sec-fetch-site': 'same-origin' })
    );

    expect(result.nextCalled).toBe(true);
  });

  test('Sec-Fetch-Site: same-origin でも Origin が不一致なら拒否する（Origin が主判定）', async () => {
    const result = await callMiddleware(
      jsonRequest('POST', '/api/uploads/abandon/', {
        origin: 'https://evil.example',
        'sec-fetch-site': 'same-origin',
      })
    );

    await expectForbidden(result);
  });

  test('form 送信（logout）も同一 origin なら通す', async () => {
    const request = new Request(`${SITE}/api/auth/logout/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE },
      body: 'lang=ja',
    });

    const result = await callMiddleware(request);

    expect(result.nextCalled).toBe(true);
  });

  test('ローカル開発（localhost の別ポート）でも同一 origin なら通す', async () => {
    const request = new Request('http://localhost:4322/api/uploads/presign/', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:4322' },
      body: '{}',
    });

    const result = await callMiddleware(request);

    expect(result.nextCalled).toBe(true);
  });

  test('GET / HEAD / OPTIONS は Origin が無くても通す（Chrome 拡張の GET /api/me/ を含む）', async () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const result = await callMiddleware(new Request(`${SITE}/api/me/`, { method }));
      expect(result.nextCalled).toBe(true);
    }
  });

  test('prerender されたページは判定しない', async () => {
    const result = await callMiddleware(jsonRequest('POST', '/ja/'), { isPrerendered: true });

    expect(result.nextCalled).toBe(true);
  });

  test('拒否応答にも COOP/COEP 等のヘッダーが付く', async () => {
    const { response } = await callMiddleware(jsonRequest('POST', '/api/uploads/presign/'));

    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('cross-origin-embedder-policy')).toBe('credentialless');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
  });

  test('通した応答にも従来どおりヘッダーが付く', async () => {
    const { response } = await callMiddleware(new Request(`${SITE}/api/health/`));

    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
  });
});

describe('checkMutationOrigin', () => {
  test('メソッド名は大文字小文字を区別せず安全側に倒す', () => {
    const request = new Request(`${SITE}/api/health/`, { method: 'get' });
    expect(checkMutationOrigin(request, new URL(request.url))).toEqual({ ok: true });
  });

  test('Sec-Fetch-Site の未知の値は Origin の一致だけで判定する', () => {
    const request = new Request(`${SITE}/api/uploads/presign/`, {
      method: 'POST',
      headers: { origin: SITE, 'sec-fetch-site': 'unexpected' },
    });
    expect(checkMutationOrigin(request, new URL(request.url))).toEqual({ ok: true });

    const missing = new Request(`${SITE}/api/uploads/presign/`, {
      method: 'POST',
      headers: { 'sec-fetch-site': 'unexpected' },
    });
    expect(checkMutationOrigin(missing, new URL(missing.url))).toEqual({
      ok: false,
      reason: 'origin_missing',
    });
  });
});
