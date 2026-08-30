import { describe, expect, it } from 'bun:test';

import { MAX_URLS_PER_PURGE } from '../../src/lib/infra/cloudflare-purge';
import { purgeMovieCache, type CachePurgeSettings } from '../../src/lib/services/cache-purge';

const ZONE_ID = '2210192b51f9f0eb6761d70341ca09b0';
const PUBLIC_BASE_URL = 'https://cdn.example';

/** 送られた files 配列を記録するフェイクの fetch。 */
class FakePurgeApi {
  readonly batches: string[][] = [];

  constructor(private readonly status = 200) {}

  readonly fetcher = (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { files: string[] };
    this.batches.push(body.files);
    return Promise.resolve(new Response(null, { status: this.status }));
  };
}

function settings(overrides: Partial<CachePurgeSettings> = {}): CachePurgeSettings {
  return {
    publicBaseUrl: PUBLIC_BASE_URL,
    zoneId: ZONE_ID,
    apiToken: 'test-token',
    source: 'test-worker',
    ...overrides,
  };
}

/** 12 文字の shortId を連番で作る（形式は contracts/r2key.ts の規則に合わせる）。 */
function shortIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `Aa${String(index).padStart(10, '0')}`);
}

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

describe('purgeMovieCache', () => {
  it('配信元とキー規則から組み立てた公開 URL を purge する', async () => {
    const api = new FakePurgeApi();

    const result = await purgeMovieCache(['AbCdEf123456'], settings({ fetcher: api.fetcher }));

    expect(result).toEqual({ requests: 1, failures: 0 });
    expect(api.batches).toEqual([[`${PUBLIC_BASE_URL}/movies/AbCdEf123456.mp4`]]);
  });

  it('30 件を超えたら 30 件ずつに分けて送る', async () => {
    const api = new FakePurgeApi();
    const ids = shortIds(MAX_URLS_PER_PURGE + 1);

    const result = await purgeMovieCache(ids, settings({ fetcher: api.fetcher }));

    expect(result.requests).toBe(2);
    expect(api.batches.map((batch) => batch.length)).toEqual([MAX_URLS_PER_PURGE, 1]);
    // 分割で取りこぼしが出ないこと（全件がどこかのリクエストに載る）。
    expect(api.batches.flat()).toHaveLength(ids.length);
  });

  it('Cloudflare が拒否しても例外にせず、失敗の件数だけ返す', async () => {
    const api = new FakePurgeApi(500);
    let result = { requests: 0, failures: 0 };

    await captureWarnLogs(async () => {
      result = await purgeMovieCache(shortIds(2), settings({ fetcher: api.fetcher }));
    });

    expect(result).toEqual({ requests: 1, failures: 1 });
  });

  it('token 未設定なら送信せず、1 回だけ warn を出す', async () => {
    const api = new FakePurgeApi();
    let result = { requests: 1, failures: 1 };

    const logs = await captureWarnLogs(async () => {
      result = await purgeMovieCache(
        shortIds(3),
        settings({ apiToken: '', fetcher: api.fetcher })
      );
    });

    expect(result).toEqual({ requests: 0, failures: 0 });
    expect(api.batches).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0]!).event).toBe('cache_purge_skipped');
  });

  it('公開 URL を組み立てられない設定では、黙って諦めずログに残す', async () => {
    const api = new FakePurgeApi();
    let result = { requests: 0, failures: 0 };

    const logs = await captureWarnLogs(async () => {
      result = await purgeMovieCache(
        shortIds(1),
        // 配信元が URL として解釈できない（vars の設定ミス）。
        settings({ publicBaseUrl: 'not a url', fetcher: api.fetcher })
      );
    });

    expect(result).toEqual({ requests: 1, failures: 1 });
    expect(api.batches).toEqual([]);
    expect(JSON.parse(logs[0]!).event).toBe('cache_purge_url_invalid');
  });

  it('消すものが無い実行では設定を見ず、ログも出さない', async () => {
    let result = { requests: 1, failures: 1 };

    const logs = await captureWarnLogs(async () => {
      result = await purgeMovieCache([], settings({ apiToken: '' }));
    });

    expect(result).toEqual({ requests: 0, failures: 0 });
    expect(logs).toEqual([]);
  });
});
