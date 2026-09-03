import { beforeAll, describe, expect, it } from 'bun:test';

import { ERROR_CODES } from '../../src/lib/contracts/api';
import {
  createSessionPayload,
  importSigningKey,
  signSession,
} from '../../src/lib/contracts/session';
import {
  json,
  noContent,
  runStreamApi,
  streamSettings,
  streamJwksResponse,
  type StreamApiBindings,
} from '../../src/lib/services/stream-api';
import {
  createStream,
  getStreamStatus,
  heartbeatStream,
  StreamError,
} from '../../src/lib/services/streams';
import { createStreamDatabase, type StreamSqliteAdapter } from './helpers/stream-db';
import { generateTestPrivateKeyBase64 } from './helpers/stream-keys';

const SESSION_SECRET = 'stream-api-test-session-key';
const FUTURE_ISSUED_AT = 2_000_000_000;
let sessionCookie: string;
let privateKey: string;

beforeAll(async () => {
  const signingKey = await importSigningKey(SESSION_SECRET);
  sessionCookie = await signSession(createSessionPayload(10, FUTURE_ISSUED_AT), signingKey);
  privateKey = await generateTestPrivateKeyBase64();
});

function bindings(database: StreamSqliteAdapter): StreamApiBindings {
  return {
    DB: database as unknown as StreamApiBindings['DB'],
    SESSION_SIGNING_KEY: SESSION_SECRET,
    STREAM_JWT_PRIVATE_KEY: privateKey,
    STREAM_EXTENSION_SECONDS: '900',
    STREAM_EXTENSION_ENABLED: 'false',
    STREAM_MAX_LIVE_PER_USER: '1',
    STREAM_CREATE_INTERVAL_SECONDS: '10',
  };
}

function request(authenticated = true): Request {
  return new Request('https://web-screen.net/api/streams/', {
    method: 'POST',
    headers: authenticated ? { Cookie: `ws_session=${sessionCookie}` } : undefined,
  });
}

describe('stream API HTTP境界', () => {
  it('延長サイクルは15分で、延長フラグの未設定既定値はfalseにする', () => {
    const settings = streamSettings({} as StreamApiBindings);
    expect(settings.extensionCycleSeconds).toBe(15 * 60);
    expect(settings.extensionEnabled).toBe(false);
    expect(streamSettings({ STREAM_EXTENSION_ENABLED: 'true' } as StreamApiBindings).extensionEnabled).toBe(true);
  });

  it('認証失敗を401 UNAUTHORIZEDへ変換する', async () => {
    const response = await runStreamApi(
      request(false),
      bindings(await createStreamDatabase()),
      async () => json({ unexpected: true })
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ errorCode: ERROR_CODES.unauthorized });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('StreamErrorを指定HTTP statusとErrorResponseへ変換する', async () => {
    const response = await runStreamApi(
      request(),
      bindings(await createStreamDatabase()),
      async () => {
        throw new StreamError(409, ERROR_CODES.streamEnded, '終了済みです');
      }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      errorCode: ERROR_CODES.streamEnded,
      message: '終了済みです',
    });
  });

  it('StreamError の公開済み待機秒数を応答へ含める', async () => {
    const response = await runStreamApi(
      request(),
      bindings(await createStreamDatabase()),
      async () => {
        throw new StreamError(409, ERROR_CODES.streamIdNotReusable, '期限待ちです', {
          retryAfterSeconds: 120,
        });
      }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      errorCode: ERROR_CODES.streamIdNotReusable,
      message: '期限待ちです',
      retryAfterSeconds: 120,
    });
  });

  it('未知例外を安全なログと500 INTERNAL_ERRORへ変換する', async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => lines.push(String(line));
    let response: Response;
    try {
      response = await runStreamApi(
        request(),
        bindings(await createStreamDatabase()),
        async () => {
          throw new Error('secret detail must not be logged');
        }
      );
    } finally {
      console.error = original;
    }
    expect(response!.status).toBe(500);
    expect(await response!.json()).toMatchObject({ errorCode: ERROR_CODES.internalError });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: 'stream_api_failed', status: 500 });
    expect(lines[0]).not.toContain('secret detail');
  });

  it('不正な設定値をaction実行前に500へ変換する', async () => {
    const invalid = bindings(await createStreamDatabase());
    invalid.STREAM_EXTENSION_SECONDS = '0';
    const original = console.error;
    console.error = () => {};
    try {
      const response = await runStreamApi(request(), invalid, async () => json({ unexpected: true }));
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ errorCode: ERROR_CODES.internalError });
    } finally {
      console.error = original;
    }
  });

  it('不正な延長フラグをaction実行前に500へ変換する', async () => {
    const invalid = bindings(await createStreamDatabase());
    invalid.STREAM_EXTENSION_ENABLED = 'enabled';
    const original = console.error;
    console.error = () => {};
    try {
      const response = await runStreamApi(request(), invalid, async () => json({ unexpected: true }));
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ errorCode: ERROR_CODES.internalError });
    } finally {
      console.error = original;
    }
  });

  it('json/noContentはstatusとno-storeを固定する', async () => {
    const ok = json({ ok: true }, 201);
    const empty = noContent();
    expect(ok.status).toBe(201);
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect(empty.status).toBe(204);
    expect(empty.headers.get('Cache-Control')).toBe('no-store');
  });

  it('公開JWKSは公開要素だけをno-storeで返す', async () => {
    const response = await streamJwksResponse(privateKey);
    const body = (await response.json()) as { keys: Array<Record<string, unknown>> };
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    for (const field of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      expect(field in body.keys[0]!).toBe(false);
    }
  });

  it('秘密鍵不正のJWKSを安全な500へ変換する', async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const response = await streamJwksResponse('not-a-pkcs8-key');
      expect(response.status).toBe(500);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ errorCode: ERROR_CODES.internalError });
    } finally {
      console.error = original;
    }
  });

  it('実認証経路で作成201・状態200・heartbeat 204を返す', async () => {
    const database = await createStreamDatabase();
    const env = bindings(database);
    const created = await runStreamApi(request(), env, async (context) =>
      json(
        await createStream({
          ...context,
          now: new Date('2026-09-01T00:00:00.789Z'),
          generateId: () => 'AbCdEf123456',
        }),
        201
      )
    );
    expect(created.status).toBe(201);

    const status = await runStreamApi(request(), env, async (context) =>
      json(
        await getStreamStatus({
          database: context.database,
          userId: context.userId,
          id: 'AbCdEf123456',
        })
      )
    );
    expect(status.status).toBe(200);

    const heartbeat = await runStreamApi(request(), env, async (context) => {
      await heartbeatStream({
        database: context.database,
        userId: context.userId,
        id: 'AbCdEf123456',
        now: new Date('2026-09-01T00:01:00.000Z'),
      });
      return noContent();
    });
    expect(heartbeat.status).toBe(204);
  });
});
