import { afterEach, describe, expect, mock, test } from 'bun:test';

import {
  createSessionPayload,
  importSigningKey,
  signSession,
} from '../../src/lib/contracts/session';

const runtimeEnv: Record<string, unknown> = {};
mock.module('cloudflare:workers', () => ({ env: runtimeEnv }));
const { POST } = await import('../../src/pages/api/uploads/presign');

const SIGNING_SECRET = 'presign-rate-limit-test-secret';
const originalError = console.error;

afterEach(() => {
  console.error = originalError;
});

function authenticatedDatabase(userId: number) {
  const statement = {
    bind: () => statement,
    first: async () => ({ id: userId, discord_id: 'discord-user', name: 'tester', avatar: null }),
  };
  return { prepare: () => statement };
}

async function authenticatedRequest(userId: number): Promise<{ request: Request; bodyReads: () => number }> {
  const signingKey = await importSigningKey(SIGNING_SECRET);
  const session = await signSession(createSessionPayload(userId), signingKey);
  const request = new Request('https://web-screen.net/api/uploads/presign/', {
    method: 'POST',
    headers: { cookie: `ws_session=${session}`, 'content-type': 'application/json' },
    body: '{}',
  });
  let reads = 0;
  Object.defineProperty(request, 'json', {
    value: async () => {
      reads += 1;
      return { filename: 'movie.mp4', sizeBytes: 100, kind: 'image' };
    },
  });
  return { request, bodyReads: () => reads };
}

async function callPresign(request: Request): Promise<Response> {
  return POST({ request } as Parameters<typeof POST>[0]);
}

describe('POST /api/uploads/presign/ のレート制限境界', () => {
  test('binding が拒否したら JSON 本文を読まず429を返す', async () => {
    Object.assign(runtimeEnv, {
      DB: authenticatedDatabase(42),
      SESSION_SIGNING_KEY: SIGNING_SECRET,
      PRESIGN_LIMITER: { limit: async () => ({ success: false }) },
    });
    const { request, bodyReads } = await authenticatedRequest(42);

    const response = await callPresign(request);

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(bodyReads()).toBe(0);
  });

  test('binding が欠落したら500にして既存の構造化ログへ記録する', async () => {
    Object.assign(runtimeEnv, {
      DB: authenticatedDatabase(42),
      SESSION_SIGNING_KEY: SIGNING_SECRET,
      PRESIGN_LIMITER: undefined,
    });
    const entries: Array<Record<string, unknown>> = [];
    console.error = ((line: string) => {
      entries.push(JSON.parse(line) as Record<string, unknown>);
    }) as typeof console.error;
    const { request, bodyReads } = await authenticatedRequest(42);

    const response = await callPresign(request);

    expect(response.status).toBe(500);
    expect(bodyReads()).toBe(0);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: 'upload_presign_failed',
      errorCode: 'INTERNAL_ERROR',
      status: 500,
    });
    expect(Object.keys(entries[0] ?? {})).not.toContain('url');
    expect(Object.keys(entries[0] ?? {})).not.toContain('cookie');
    expect(Object.keys(entries[0] ?? {})).not.toContain('shortId');
  });
});
