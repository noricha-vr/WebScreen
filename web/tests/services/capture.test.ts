import { beforeAll, describe, expect, test } from 'bun:test';

import {
  createSessionPayload,
  importSigningKey,
  signSession,
} from '../../src/lib/contracts/session';
import { proxyCapture, type CaptureFetcher } from '../../src/lib/services/capture';
import type { UserStatement, UsersDatabase } from '../../src/lib/infra/users';

const NOW = 1_700_000_000;
let signingKey: CryptoKey;

beforeAll(async () => {
  signingKey = await importSigningKey('test-signing-key');
});

describe('proxyCapture', () => {
  test.each([
    ['private 10/8', 'http://10.1.2.3/'],
    ['private 172.16/12', 'http://172.16.0.1/'],
    ['private 192.168/16', 'http://192.168.1.1/'],
    ['loopback IPv4', 'http://127.0.0.1/'],
    ['link-local IPv4', 'http://169.254.10.1/'],
    ['loopback IPv6', 'http://[::1]/'],
    ['IPv4-mapped loopback IPv6', 'http://[::ffff:7f00:1]/'],
    ['localhost', 'http://localhost/'],
    ['localhost subdomain', 'http://preview.localhost/'],
    ['ftp scheme', 'ftp://example.com/file'],
  ])('%s を 400 で拒否する', async (_label, url) => {
    let fetchCount = 0;

    const response = await proxyCapture(captureRequest({ url }), {
      ...authenticatedDependencies(),
      fetcher: async () => {
        fetchCount += 1;
        return Response.json({ images: [] });
      },
    });

    expect(response.status).toBe(400);
    expect(fetchCount).toBe(0);
  });

  test('認証なしは 401 を返し、下流を呼ばない', async () => {
    let fetchCount = 0;

    const response = await proxyCapture(captureRequest({ url: 'https://example.com/' }), {
      ...authenticatedDependencies(),
      database: new FakeUsersDatabase(null),
      fetcher: async () => {
        fetchCount += 1;
        return Response.json({ images: [] });
      },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ errorCode: 'UNAUTHORIZED', message: '認証が必要です' });
    expect(fetchCount).toBe(0);
  });

  test('下流の失敗を 502 に変換する', async () => {
    const response = await proxyCapture(captureRequest({ url: 'https://example.com/' }), {
      ...authenticatedDependencies(),
      fetcher: async () => new Response('upstream error', { status: 500 }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ errorCode: 'CAPTURE_FAILED' });
  });

  test('非 JSON の下流エラーは 1 件だけ構造化ログに記録する', async () => {
    const originalError = console.error;
    const entries: string[] = [];
    console.error = ((entry: string) => entries.push(entry)) as typeof console.error;

    try {
      const response = await proxyCapture(captureRequest({ url: 'https://example.com/' }), {
        ...authenticatedDependencies(),
        fetcher: async () => new Response('upstream error', { status: 422 }),
      });

      expect(response.status).toBe(502);
      expect(entries).toHaveLength(1);
      expect(JSON.parse(entries[0] ?? '{}')).toMatchObject({
        event: 'capture_upstream_error_unmapped',
        errorCode: 'CAPTURE_FAILED',
      });
    } finally {
      console.error = originalError;
    }
  });

  test('下流の capture_limit_exceeded を PAGE_TOO_LONG の 400 に変換する', async () => {
    const response = await proxyCapture(captureRequest({ url: 'https://example.com/' }), {
      ...authenticatedDependencies(),
      fetcher: async () => Response.json({ errorCode: 'capture_limit_exceeded' }, { status: 400 }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errorCode: 'PAGE_TOO_LONG' });
  });

  test('下流の capture_timeout を CAPTURE_TIMEOUT の 504 に変換する', async () => {
    const response = await proxyCapture(captureRequest({ url: 'https://example.com/' }), {
      ...authenticatedDependencies(),
      fetcher: async () => Response.json({ errorCode: 'capture_timeout' }, { status: 504 }),
    });

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ errorCode: 'CAPTURE_TIMEOUT' });
  });

  test.each([
    ['pdf_url_not_supported', 'PDF_URL_NOT_SUPPORTED'],
    ['image_url_not_supported', 'IMAGE_URL_NOT_SUPPORTED'],
    ['video_url_not_supported', 'VIDEO_URL_NOT_SUPPORTED'],
    ['non_web_page_url', 'NON_WEB_PAGE_URL'],
  ])('許可した下流コード %s だけを %s の 422 に変換する', async (lowerCode, upperCode) => {
    const rawMessage = 'upstream internal detail';
    const response = await proxyCapture(captureRequest({ url: 'https://example.com/' }), {
      ...authenticatedDependencies(),
      fetcher: async () => Response.json({ errorCode: lowerCode, message: rawMessage }, { status: 422 }),
    });

    const body = await response.json() as { errorCode: string; message: string };
    expect(response.status).toBe(422);
    expect(body.errorCode).toBe(upperCode);
    expect(body.message).not.toContain(rawMessage);
  });

  test.each([
    ['未知コード', Response.json({ errorCode: 'unexpected_failure', message: 'raw detail' }, { status: 422 })],
    ['errorCode が無い JSON', Response.json({ message: 'raw detail' }, { status: 422 })],
    ['非 JSON', new Response('raw detail', { status: 422 })],
    ['401', Response.json({ errorCode: 'pdf_url_not_supported', message: 'raw detail' }, { status: 401 })],
    ['429', Response.json({ errorCode: 'pdf_url_not_supported', message: 'raw detail' }, { status: 429 })],
    ['5xx', Response.json({ errorCode: 'pdf_url_not_supported', message: 'raw detail' }, { status: 503 })],
  ])('%s は CAPTURE_FAILED に留め、下流メッセージを公開しない', async (_label, upstream) => {
    const response = await proxyCapture(captureRequest({ url: 'https://example.com/' }), {
      ...authenticatedDependencies(),
      fetcher: async () => upstream.clone(),
    });

    const body = await response.json() as { errorCode: string; message: string };
    expect(response.status).toBe(502);
    expect(body.errorCode).toBe('CAPTURE_FAILED');
    expect(body.message).not.toContain('raw detail');
  });

  test('下流タイムアウトを 504 に変換する', async () => {
    const response = await proxyCapture(captureRequest({ url: 'https://example.com/' }), {
      ...authenticatedDependencies(),
      timeoutMs: 1,
      fetcher: timeoutFetcher,
    });

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ errorCode: 'CAPTURE_TIMEOUT' });
  });

  test('下流の images 配列を順序を変えず返す', async () => {
    const images = ['https://images.test/0000.webp', 'https://images.test/0001.webp'];
    let forwardedRequest: Request | undefined;
    const fetcher: CaptureFetcher = async (input, init) => {
      forwardedRequest = new Request(input, init);
      return Response.json({ images });
    };

    const response = await proxyCapture(
      captureRequest({ url: 'https://example.com/', width: 1280, height: 720 }),
      { ...authenticatedDependencies(), fetcher }
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ images });
    expect(forwardedRequest?.url).toBe('http://web-capture.test/capture');
    expect(forwardedRequest?.headers.get('Authorization')).toBe('Bearer test-capture-token');
    expect(await forwardedRequest?.json()).toEqual({
      url: 'https://example.com/',
      width: 1280,
      height: 720,
    });
  });
});

function authenticatedDependencies() {
  return {
    database: new FakeUsersDatabase({
      id: 42,
      discord_id: '123456789',
      name: 'WebScreen User',
      avatar: 'avatar-hash',
    }),
    signingKey,
    nowSeconds: NOW,
    webCaptureUrl: 'http://web-capture.test',
    webCaptureToken: 'test-capture-token',
  };
}

function captureRequest(body: unknown): Request {
  return new Request('https://example.test/api/capture/', {
    method: 'POST',
    headers: { Cookie: `ws_session=${sessionToken}` },
    body: JSON.stringify(body),
  });
}

const sessionToken = await signSession(createSessionPayload(42, NOW), await importSigningKey('test-signing-key'));

const timeoutFetcher: CaptureFetcher = async (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  });

class FakeUsersDatabase implements UsersDatabase {
  constructor(private readonly row: Record<string, unknown> | null) {}

  prepare(): UserStatement {
    return {
      bind: () => this.prepare(),
      first: async <T>() => this.row as T | null,
    };
  }
}
