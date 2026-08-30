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
  return new Request('http://localhost/api/client-error/', { method: 'POST', body, headers });
}

describe('POST /api/client-error/', () => {
  test('正しい報告は 204 を返し、client_error として 1 行だけ記録する', async () => {
    const logs = captureLogs();

    const response = await handleClientErrorReport(
      reportRequest(JSON.stringify({ stage: 'capture', errorCode: 'captureTimeout', httpStatus: 504 }))
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
          cookie: 'ws_session=deadbeef',
          'user-agent': 'Mozilla/5.0 (Secret Browser)',
          referer: 'https://example.com/private/page',
        },
      })
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
        headers: { cookie },
      }),
      { signingKey: key }
    );

    expect(response.status).toBe(204);
    expect((logs.entries[0] as Record<string, unknown>)['userId']).toBe(42);
  });

  test('未ログイン（Cookie 無し）でも 204 で記録する', async () => {
    const logs = captureLogs();
    const key = await importSigningKey('unit-test-signing-key');

    const response = await handleClientErrorReport(
      reportRequest(JSON.stringify({ stage: 'history', errorCode: 'failed' })),
      { signingKey: key }
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
        headers: { cookie: 'ws_session=eyJ1aWQiOjF9.forged' },
      }),
      { signingKey: key }
    );

    expect(logs.entries[0]).not.toHaveProperty('userId');
  });

  test('未知のフィールドを含む報告は 400 で捨て、ログにも残さない', async () => {
    const logs = captureLogs();

    const response = await handleClientErrorReport(
      reportRequest(
        JSON.stringify({ stage: 'convert', errorCode: 'failed', stack: 'at /Users/me/secret.pdf' })
      )
    );

    expect(response.status).toBe(400);
    expect(logs.entries).toHaveLength(0);
  });

  test('allowlist 外の errorCode は 400 で拒否する', async () => {
    const logs = captureLogs();

    const response = await handleClientErrorReport(
      reportRequest(JSON.stringify({ stage: 'convert', errorCode: 'https://example.com/leak' }))
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

    const response = await handleClientErrorReport(reportRequest(oversized));

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
        headers: { 'content-length': '10' },
      })
    );

    expect(response.status).toBe(400);
    expect(logs.entries).toHaveLength(0);
  });

  test('JSON として読めない本文は 400 で拒否する', async () => {
    const logs = captureLogs();

    const response = await handleClientErrorReport(reportRequest('not json'));

    expect(response.status).toBe(400);
    expect(logs.entries).toHaveLength(0);
  });
});
