import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { streamJwksResponse } from '../../src/lib/services/stream-api';
import { resetRemoteJwksCache } from '../../src/lib/services/stream-jwks-merge';
import { generateTestPrivateKeyBase64 } from './helpers/stream-keys';

const MERGE_URL = 'https://app.choicast.com/api/streams/jwks/';
const REMOTE_KEY = { kty: 'RSA', kid: 'choicast-1', n: 'remote-n', e: 'AQAB', alg: 'RS256', use: 'sig' };

let privateKey: string;
let ownKid: string;
const warnings: string[] = [];
const originalWarn = console.warn;

interface JwksBody {
  keys: Array<Record<string, unknown>>;
}

/** 呼び出し回数を数え、決められた応答を返すフェイクの fetch。 */
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetcher = async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input));
    return respond();
  };
  return { calls, fetcher };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function body(response: Response): Promise<JwksBody> {
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  return (await response.json()) as JwksBody;
}

beforeAll(async () => {
  privateKey = await generateTestPrivateKeyBase64();
  const own = await body(await streamJwksResponse(privateKey));
  ownKid = own.keys[0]!.kid as string;
});

beforeEach(() => {
  resetRemoteJwksCache();
  warnings.length = 0;
  console.warn = (line: string) => {
    warnings.push(line);
  };
});

afterEach(() => {
  console.warn = originalWarn;
});

describe('JWKS への他サービス公開鍵の併載', () => {
  it('URL 未指定なら自鍵だけを返し fetch を呼ばない', async () => {
    const api = fakeFetch(() => jsonResponse({ keys: [REMOTE_KEY] }));
    const { keys } = await body(await streamJwksResponse(privateKey, undefined, { fetcher: api.fetcher }));
    expect(keys).toHaveLength(1);
    expect(api.calls).toHaveLength(0);
  });

  it('取得した RSA 公開鍵を自鍵の後ろに併載し、必要な要素だけに射影する', async () => {
    const api = fakeFetch(() =>
      jsonResponse({
        keys: [
          { ...REMOTE_KEY, x5c: ['should-not-be-echoed'] },
          { kty: 'EC', kid: 'ec-1', crv: 'P-256', x: 'x', y: 'y' },
          { kty: 'RSA', kid: 'missing-e', n: 'n' },
          'not-an-object',
        ],
      })
    );
    const { keys } = await body(await streamJwksResponse(privateKey, MERGE_URL, { fetcher: api.fetcher }));
    expect(keys.map((key) => key.kid)).toEqual([ownKid, 'choicast-1']);
    expect(keys[1]).toEqual({
      kty: 'RSA',
      kid: 'choicast-1',
      n: 'remote-n',
      e: 'AQAB',
      alg: 'RS256',
      use: 'sig',
      key_ops: ['verify'],
    });
    expect(api.calls).toEqual([MERGE_URL]);
    expect(warnings).toHaveLength(0);
  });

  it.each([
    ['接続失敗', () => Promise.reject(new TypeError('fetch failed')), 'request_failed'],
    ['非 200', () => jsonResponse({ keys: [REMOTE_KEY] }, 503), 'rejected'],
    ['JSON 不正', () => new Response('<html>', { status: 200 }), 'invalid_json'],
    ['keys が配列でない', () => jsonResponse({ keys: { kid: 'x' } }), 'invalid_shape'],
  ])('%s なら自鍵だけを返し warn を 1 行出す', async (_label, respond, reason) => {
    const api = fakeFetch(respond as () => Response | Promise<Response>);
    const { keys } = await body(await streamJwksResponse(privateKey, MERGE_URL, { fetcher: api.fetcher }));
    expect(keys.map((key) => key.kid)).toEqual([ownKid]);
    expect(warnings).toHaveLength(1);
    expect(JSON.parse(warnings[0]!)).toMatchObject({
      level: 'warn',
      event: 'stream_jwks_merge_failed',
      reason,
    });
    expect(warnings[0]).not.toContain(MERGE_URL);
  });

  it('kid が自鍵と衝突したら自鍵を優先し、同じ kid の重複も 1 つにする', async () => {
    const api = fakeFetch(() =>
      jsonResponse({
        keys: [
          { kty: 'RSA', kid: ownKid, n: 'impostor-n', e: 'AQAB' },
          REMOTE_KEY,
          { ...REMOTE_KEY, n: 'duplicate-n' },
        ],
      })
    );
    const { keys } = await body(await streamJwksResponse(privateKey, MERGE_URL, { fetcher: api.fetcher }));
    expect(keys.map((key) => key.kid)).toEqual([ownKid, 'choicast-1']);
    expect(keys[0]!.n).not.toBe('impostor-n');
    expect(keys[1]!.n).toBe('remote-n');
  });

  it('取得成功は 5 分キャッシュされ、期限が切れたら取り直す', async () => {
    let now = 1_000_000;
    const api = fakeFetch(() => jsonResponse({ keys: [REMOTE_KEY] }));
    const options = { fetcher: api.fetcher, now: () => now };
    for (let i = 0; i < 3; i += 1) {
      const { keys } = await body(await streamJwksResponse(privateKey, MERGE_URL, options));
      expect(keys).toHaveLength(2);
    }
    expect(api.calls).toHaveLength(1);

    now += 5 * 60 * 1000;
    await body(await streamJwksResponse(privateKey, MERGE_URL, options));
    expect(api.calls).toHaveLength(2);
  });

  it('取得失敗は 30 秒だけ保持し、その後の取り直しで復旧する', async () => {
    let now = 1_000_000;
    let healthy = false;
    const api = fakeFetch(() =>
      healthy ? jsonResponse({ keys: [REMOTE_KEY] }) : jsonResponse({ error: 'down' }, 500)
    );
    const options = { fetcher: api.fetcher, now: () => now };

    await body(await streamJwksResponse(privateKey, MERGE_URL, options));
    await body(await streamJwksResponse(privateKey, MERGE_URL, options));
    expect(api.calls).toHaveLength(1);
    expect(warnings).toHaveLength(1);

    healthy = true;
    now += 30 * 1000;
    const { keys } = await body(await streamJwksResponse(privateKey, MERGE_URL, options));
    expect(api.calls).toHaveLength(2);
    expect(keys.map((key) => key.kid)).toEqual([ownKid, 'choicast-1']);
  });
});
