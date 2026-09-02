import { beforeAll, describe, expect, mock, test } from 'bun:test';

import {
  createSessionPayload,
  importSigningKey,
  signSession,
} from '../../src/lib/contracts/session';
import { STREAM_START_TOKEN_HEADER } from '../../src/lib/contracts/streams';
import { createStreamDatabase, type StreamSqliteAdapter } from '../services/helpers/stream-db';
import { generateTestPrivateKeyBase64 } from '../services/helpers/stream-keys';

const runtimeEnv: Record<string, unknown> = {};
mock.module('cloudflare:workers', () => ({ env: runtimeEnv }));
const { POST: createPost } = await import('../../src/pages/api/streams/index');
const { POST: cancelPost } = await import('../../src/pages/api/streams/cancel-start');

const SESSION_SECRET = 'stream-start-cancel-session-key';
const START_TOKEN = '11111111-1111-4111-8111-111111111111';
let sessionCookie: string;
let privateKey: string;

beforeAll(async () => {
  const signingKey = await importSigningKey(SESSION_SECRET);
  sessionCookie = await signSession(createSessionPayload(10), signingKey);
  privateKey = await generateTestPrivateKeyBase64();
});

function setBindings(database: StreamSqliteAdapter): void {
  Object.assign(runtimeEnv, {
    DB: database,
    SESSION_SIGNING_KEY: SESSION_SECRET,
    STREAM_JWT_PRIVATE_KEY: privateKey,
    STREAM_EXTENSION_SECONDS: '7200',
    STREAM_MAX_LIVE_PER_USER: '1',
    STREAM_MAX_LIVE: '20',
    STREAM_CREATE_INTERVAL_SECONDS: '10',
  });
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { cookie: `ws_session=${sessionCookie}`, ...extra };
}

function callCreate(request: Request): Promise<Response> | Response {
  return createPost({ request } as Parameters<typeof createPost>[0]);
}

function callCancel(request: Request): Promise<Response> | Response {
  return cancelPost({ request } as Parameters<typeof cancelPost>[0]);
}

describe('配信開始token API境界', () => {
  test('createの不正なtoken headerを400で拒否する', async () => {
    const database = await createStreamDatabase();
    setBindings(database);
    const response = await callCreate(
      new Request('https://web-screen.net/api/streams/', {
        method: 'POST',
        headers: authHeaders({ [STREAM_START_TOKEN_HEADER]: 'not-a-uuid' }),
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ errorCode: 'INVALID_REQUEST' });
    expect(database.sqlite.query('SELECT COUNT(*) AS count FROM stream_sessions').get()).toEqual({
      count: 0,
    });
  });

  test('token headerを送らない旧クライアントも201で作成できる', async () => {
    const database = await createStreamDatabase();
    setBindings(database);
    const response = await callCreate(
      new Request('https://web-screen.net/api/streams/', {
        method: 'POST',
        headers: authHeaders(),
      })
    );

    expect(response.status).toBe(201);
    expect(database.sqlite.query('SELECT start_token FROM stream_sessions').get()).toEqual({
      start_token: null,
    });
  });

  test('有効なheader tokenをcreate行へ保存する', async () => {
    const database = await createStreamDatabase();
    setBindings(database);
    const response = await callCreate(
      new Request('https://web-screen.net/api/streams/', {
        method: 'POST',
        headers: authHeaders({ [STREAM_START_TOKEN_HEADER]: START_TOKEN }),
      })
    );

    expect(response.status).toBe(201);
    expect(database.sqlite.query('SELECT start_token FROM stream_sessions').get()).toEqual({
      start_token: START_TOKEN,
    });
  });

  test('cancel-startはContent-Typeと厳格なUUID本文を検証する', async () => {
    const database = await createStreamDatabase();
    setBindings(database);
    const missingContentType = await callCancel(
      new Request('https://web-screen.net/api/streams/cancel-start/', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ startToken: START_TOKEN }),
      })
    );
    const invalidBody = await callCancel(
      new Request('https://web-screen.net/api/streams/cancel-start/', {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ startToken: 'not-a-uuid', extra: true }),
      })
    );

    expect(missingContentType.status).toBe(400);
    expect(invalidBody.status).toBe(400);
    expect(await invalidBody.json()).toMatchObject({ errorCode: 'INVALID_REQUEST' });
  });

  test('cancel-startの本文が上限を超えたら413にする', async () => {
    const database = await createStreamDatabase();
    setBindings(database);
    const response = await callCancel(
      new Request('https://web-screen.net/api/streams/cancel-start/', {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ startToken: START_TOKEN, padding: 'x'.repeat(1_024) }),
      })
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ errorCode: 'PAYLOAD_TOO_LARGE' });
  });

  test('cancel-startは有効な本文を204で冪等に受理しmatching liveを終了する', async () => {
    const database = await createStreamDatabase();
    setBindings(database);
    await callCreate(
      new Request('https://web-screen.net/api/streams/', {
        method: 'POST',
        headers: authHeaders({ [STREAM_START_TOKEN_HEADER]: START_TOKEN }),
      })
    );
    const request = () =>
      new Request('https://web-screen.net/api/streams/cancel-start/', {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json; charset=utf-8' }),
        body: JSON.stringify({ startToken: START_TOKEN }),
      });

    expect((await callCancel(request())).status).toBe(204);
    expect((await callCancel(request())).status).toBe(204);
    expect(database.sqlite.query('SELECT status, end_reason FROM stream_sessions').get()).toEqual({
      status: 'ended',
      end_reason: 'user_stop',
    });
  });

  test('cancel-start 204後の同token createを409にしてliveを作らない', async () => {
    const database = await createStreamDatabase();
    setBindings(database);
    const cancelled = await callCancel(
      new Request('https://web-screen.net/api/streams/cancel-start/', {
        method: 'POST',
        headers: authHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ startToken: START_TOKEN }),
      })
    );
    const created = await callCreate(
      new Request('https://web-screen.net/api/streams/', {
        method: 'POST',
        headers: authHeaders({ [STREAM_START_TOKEN_HEADER]: START_TOKEN }),
      })
    );

    expect(cancelled.status).toBe(204);
    expect(created.status).toBe(409);
    expect(await created.json()).toMatchObject({ errorCode: 'STREAM_START_CANCELLED' });
    expect(
      database.sqlite.query("SELECT COUNT(*) AS count FROM stream_sessions WHERE status = 'live'").get()
    ).toEqual({ count: 0 });
  });
});
