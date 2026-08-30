import { afterEach, describe, expect, test } from 'bun:test';

import {
  createSessionPayload,
  importSigningKey,
  signSession,
} from '../../src/lib/contracts/session';
import { handleClientErrorReport } from '../../src/lib/services/client-error';

const originalWarn = console.warn;

afterEach(() => {
  console.warn = originalWarn;
});

/** ログ 1 行を JSON として取り出す。出力の形そのものが契約なので構造で検証する。 */
function captureLogs(): { entries: Record<string, unknown>[] } {
  const entries: Record<string, unknown>[] = [];
  console.warn = ((line: string) => {
    entries.push(JSON.parse(line) as Record<string, unknown>);
  }) as typeof console.warn;
  return { entries };
}

function reportRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/client-error/', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** 常に通す / 常に断る Rate Limiting binding の代役。 */
function limiterStub(success: boolean, keys: string[] = []): { limit: (o: { key: string }) => Promise<{ success: boolean }> } {
  return {
    limit: async ({ key }) => {
      keys.push(key);
      return { success };
    },
  };
}

const allowAll = { limiter: limiterStub(true) };

describe('POST /api/client-error/ のレート制限', () => {
  // このファイルで唯一 limiter を渡さないテスト。binding 不在の警告は isolate ごとに
  // 1 回だけなので、他のテストへ警告が漏れないよう先頭に置く。
  test('binding が無い環境では警告を 1 回だけ出して受け付ける', async () => {
    const logs = captureLogs();

    const first = await handleClientErrorReport(
      reportRequest(JSON.stringify({ stage: 'convert', errorCode: 'failed' }))
    );
    const second = await handleClientErrorReport(
      reportRequest(JSON.stringify({ stage: 'convert', errorCode: 'failed' }))
    );

    expect([first.status, second.status]).toEqual([204, 204]);
    const events = logs.entries.map((entry) => entry['event']);
    expect(events).toEqual(['client_error_limiter_missing', 'client_error', 'client_error']);
  });

  test('上限を超えたら 429 を返し、本文もログも出さない', async () => {
    const logs = captureLogs();

    const response = await handleClientErrorReport(
      reportRequest(JSON.stringify({ stage: 'convert', errorCode: 'failed' })),
      { limiter: limiterStub(false) }
    );

    expect(response.status).toBe(429);
    expect(await response.text()).toBe('');
    expect(logs.entries).toHaveLength(0);
  });

  test('接続元 IP を鍵にする（無い経路は 1 つに束ねる）', async () => {
    const keys: string[] = [];
    captureLogs();

    await handleClientErrorReport(
      reportRequest(JSON.stringify({ stage: 'convert', errorCode: 'failed' }), {
        'cf-connecting-ip': '203.0.113.9',
      }),
      { limiter: limiterStub(true, keys) }
    );
    await handleClientErrorReport(
      reportRequest(JSON.stringify({ stage: 'convert', errorCode: 'failed' })),
      { limiter: limiterStub(true, keys) }
    );

    expect(keys).toEqual(['203.0.113.9', 'unknown']);
  });
});

describe('POST /api/client-error/', () => {
  test('application/json 以外の Content-Type は 400 で拒否する', async () => {
    const logs = captureLogs();
    const body = JSON.stringify({ stage: 'convert', errorCode: 'failed' });

    const plain = await handleClientErrorReport(
      new Request('http://localhost/api/client-error/', {
        method: 'POST',
        body,
        headers: { 'content-type': 'text/plain;charset=UTF-8' },
      }),
      allowAll
    );
    const withCharset = await handleClientErrorReport(
      reportRequest(body, { 'content-type': 'application/json; charset=utf-8' }),
      allowAll
    );

    expect(plain.status).toBe(400);
    expect(withCharset.status).toBe(204);
    expect(logs.entries).toHaveLength(1);
  });

  test('正しい報告は 204 を返し、client_error として 1 行だけ記録する', async () => {
    const logs = captureLogs();

    const response = await handleClientErrorReport(
      reportRequest(JSON.stringify({ stage: 'capture', errorCode: 'captureTimeout', httpStatus: 504 })),
      allowAll
    );

    expect(response.status).toBe(204);
    expect(logs.entries).toHaveLength(1);
    const entry = logs.entries[0] as Record<string, unknown>;
    expect(entry['event']).toBe('client_error');
    expect(entry['stage']).toBe('capture');
    expect(entry['errorCode']).toBe('captureTimeout');
    expect(entry['httpStatus']).toBe(504);
  });

  test('ログに残るキーは識別子だけ（URL・Cookie・UA を持ち込まない）', async () => {
    const logs = captureLogs();

    await handleClientErrorReport(
      new Request('http://localhost/api/client-error/?debug=secret', {
        method: 'POST',
        body: JSON.stringify({ stage: 'convert', errorCode: 'failed' }),
        headers: {
          'content-type': 'application/json',
          cookie: 'ws_session=deadbeef',
          'user-agent': 'Mozilla/5.0 (Secret Browser)',
          referer: 'https://example.com/private/page',
        },
      }),
      allowAll
    );

    const entry = logs.entries[0] as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual([
      'errorCode',
      'event',
      'kind',
      'level',
      'severity',
      'source',
      'stage',
      'summary',
      'timestamp',
    ]);
    expect(JSON.stringify(entry)).not.toContain('Secret Browser');
    expect(JSON.stringify(entry)).not.toContain('example.com');
    expect(JSON.stringify(entry)).not.toContain('deadbeef');
  });

  test('署名済み Cookie があれば userId を添える', async () => {
    const logs = captureLogs();
    const key = await importSigningKey('unit-test-signing-key');
    const cookie = `ws_session=${await signSession(createSessionPayload(42), key)}`;

    const response = await handleClientErrorReport(
      new Request('http://localhost/api/client-error/', {
        method: 'POST',
        body: JSON.stringify({ stage: 'pin', errorCode: 'failed' }),
        headers: { 'content-type': 'application/json', cookie },
      }),
      { signingKey: key, ...allowAll }
    );

    expect(response.status).toBe(204);
    expect((logs.entries[0] as Record<string, unknown>)['userId']).toBe(42);
  });

  test('未ログイン（Cookie 無し）でも 204 で記録する', async () => {
    const logs = captureLogs();
    const key = await importSigningKey('unit-test-signing-key');

    const response = await handleClientErrorReport(
      reportRequest(JSON.stringify({ stage: 'history', errorCode: 'failed' })),
      { signingKey: key, ...allowAll }
    );

    expect(response.status).toBe(204);
    expect(logs.entries[0]).not.toHaveProperty('userId');
  });

  test('改竄された Cookie は userId を付けずに記録する', async () => {
    const logs = captureLogs();
    const key = await importSigningKey('unit-test-signing-key');

    await handleClientErrorReport(
      new Request('http://localhost/api/client-error/', {
        method: 'POST',
        body: JSON.stringify({ stage: 'pin', errorCode: 'failed' }),
        headers: { 'content-type': 'application/json', cookie: 'ws_session=eyJ1aWQiOjF9.forged' },
      }),
      { signingKey: key, ...allowAll }
    );

    expect(logs.entries[0]).not.toHaveProperty('userId');
  });

  test('未知のフィールドを含む報告は 400 で捨て、ログにも残さない', async () => {
    const logs = captureLogs();

    const response = await handleClientErrorReport(
      reportRequest(
        JSON.stringify({ stage: 'convert', errorCode: 'failed', stack: 'at /Users/me/secret.pdf' })
      ),
      allowAll
    );

    expect(response.status).toBe(400);
    expect(logs.entries).toHaveLength(0);
  });

  test('allowlist 外の errorCode は 400 で拒否する', async () => {
    const logs = captureLogs();

    const response = await handleClientErrorReport(
      reportRequest(JSON.stringify({ stage: 'convert', errorCode: 'https://example.com/leak' })),
      allowAll
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      errorCode: 'INVALID_REQUEST',
      message: 'errorCode が不正です',
    });
    expect(logs.entries).toHaveLength(0);
  });

  test('1 KiB を超える本文は 400 で拒否する', async () => {
    const logs = captureLogs();
    const oversized = JSON.stringify({
      stage: 'convert',
      errorCode: 'failed',
      pad: 'x'.repeat(2000),
    });

    const response = await handleClientErrorReport(reportRequest(oversized), allowAll);

    expect(response.status).toBe(400);
    expect(logs.entries).toHaveLength(0);
  });

  test('Content-Length を偽っても実バイト数で打ち切る', async () => {
    const logs = captureLogs();
    const oversized = 'x'.repeat(4000);

    const response = await handleClientErrorReport(
      new Request('http://localhost/api/client-error/', {
        method: 'POST',
        body: oversized,
        headers: { 'content-type': 'application/json', 'content-length': '10' },
      }),
      allowAll
    );

    expect(response.status).toBe(400);
    expect(logs.entries).toHaveLength(0);
  });

  test('JSON として読めない本文は 400 で拒否する', async () => {
    const logs = captureLogs();

    const response = await handleClientErrorReport(reportRequest('not json'), allowAll);

    expect(response.status).toBe(400);
    expect(logs.entries).toHaveLength(0);
  });
});
