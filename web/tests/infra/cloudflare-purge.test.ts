import { describe, expect, it } from 'bun:test';

import { purgeCachedUrls } from '../../src/lib/infra/cloudflare-purge';

const ZONE_ID = '2210192b51f9f0eb6761d70341ca09b0';
const API_TOKEN = 'test-token';
const URL_A = 'https://cdn.example/movies/AbCdEf123456.mp4';

/** console.warn を差し替えて、出力された 1 行 JSON を取る。 */
async function captureWarnLogs(run: () => Promise<void>): Promise<string[]> {
  const original = console.warn;
  const entries: string[] = [];
  console.warn = (entry: unknown) => {
    entries.push(String(entry));
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return entries;
}

describe('purgeCachedUrls', () => {
  it('ゾーンの purge_cache へ files として POST し、成功なら true', async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;

    const purged = await purgeCachedUrls({
      urls: [URL_A],
      zoneId: ZONE_ID,
      apiToken: API_TOKEN,
      source: 'test-worker',
      fetcher: (url, init) => {
        seen = { url: String(url), init };
        return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
      },
    });

    expect(purged).toBe(true);
    expect(seen!.url).toBe(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache`);
    expect(seen!.init?.method).toBe('POST');
    expect((seen!.init?.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${API_TOKEN}`
    );
    expect(JSON.parse(String(seen!.init?.body))).toEqual({ files: [URL_A] });
  });

  it('Cloudflare が拒否したら false を返し、例外にしない', async () => {
    let purged = true;
    const logs = await captureWarnLogs(async () => {
      purged = await purgeCachedUrls({
        urls: [URL_A],
        zoneId: ZONE_ID,
        apiToken: API_TOKEN,
        source: 'test-worker',
        fetcher: () => Promise.resolve(new Response('forbidden', { status: 403 })),
      });
    });

    expect(purged).toBe(false);
    const entry = JSON.parse(logs[0]!);
    expect(entry.event).toBe('cache_purge_failed');
    expect(entry.status).toBe(403);
    // 動画 URL は shortId が唯一の保護なので、失敗してもログには出さない。
    expect(logs[0]).not.toContain('AbCdEf123456');
    expect(logs[0]).not.toContain(API_TOKEN);
  });

  it('200 でも本文が success: false なら失敗として扱う', async () => {
    let purged = true;
    const logs = await captureWarnLogs(async () => {
      purged = await purgeCachedUrls({
        urls: [URL_A],
        zoneId: ZONE_ID,
        apiToken: API_TOKEN,
        source: 'test-worker',
        fetcher: () =>
          Promise.resolve(
            new Response(JSON.stringify({ success: false, errors: [{ code: 1012 }] }), {
              status: 200,
            })
          ),
      });
    });

    expect(purged).toBe(false);
    expect(JSON.parse(logs[0]!).reason).toBe('not_successful');
  });

  it('本文が JSON でなくてもステータスが 2xx なら成功として扱う', async () => {
    const purged = await purgeCachedUrls({
      urls: [URL_A],
      zoneId: ZONE_ID,
      apiToken: API_TOKEN,
      source: 'test-worker',
      fetcher: () => Promise.resolve(new Response('OK', { status: 200 })),
    });

    expect(purged).toBe(true);
  });

  it('ネットワーク障害でも false を返し、呼び出し側を落とさない', async () => {
    let purged = true;
    const logs = await captureWarnLogs(async () => {
      purged = await purgeCachedUrls({
        urls: [URL_A],
        zoneId: ZONE_ID,
        apiToken: API_TOKEN,
        source: 'test-worker',
        fetcher: () => Promise.reject(new Error('timed out')),
      });
    });

    expect(purged).toBe(false);
    expect(JSON.parse(logs[0]!).reason).toBe('request_failed');
  });

  it('ゾーン ID の形式が不正なら送信しない', async () => {
    let called = false;

    const purged = await purgeCachedUrls({
      urls: [URL_A],
      zoneId: '../zones/other-zone',
      apiToken: API_TOKEN,
      source: 'test-worker',
      fetcher: () => {
        called = true;
        return Promise.resolve(new Response(null, { status: 200 }));
      },
    });

    expect(purged).toBe(false);
    expect(called).toBe(false);
  });
});
