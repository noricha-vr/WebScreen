import { beforeAll, describe, expect, test } from 'bun:test';

import {
  OAUTH_STATE_TTL_SECONDS,
  createSessionPayload,
  importSigningKey,
  signSession,
} from '../../src/lib/contracts/session';
import {
  consumeOAuthState,
  createOAuthState,
  requireUser,
} from '../../src/lib/services/auth';
import type {
  UserStatement,
  UsersDatabase,
} from '../../src/lib/infra/users';

const NOW = 1_700_000_000;
const FIXED_STATE = 'fixed-oauth-state';

let signingKey: CryptoKey;

beforeAll(async () => {
  signingKey = await importSigningKey('test-signing-key');
});

describe('OAuth state', () => {
  test('署名・期限・query が正しければ成功する', async () => {
    const issued = await createOAuthState(signingKey, NOW, () => FIXED_STATE);
    let cookie: string | undefined = issued.cookieValue;

    const valid = await consumeOAuthState(() => takeCookie(), FIXED_STATE, signingKey, NOW);

    expect(valid).toBe(true);

    function takeCookie(): string | undefined {
      const value = cookie;
      cookie = undefined;
      return value;
    }
  });

  test('query state が一致しなければ拒否する', async () => {
    const issued = await createOAuthState(signingKey, NOW, () => FIXED_STATE);

    expect(
      await consumeOAuthState(() => issued.cookieValue, 'different-state', signingKey, NOW)
    ).toBe(false);
  });

  test('期限切れ state を拒否する', async () => {
    const issued = await createOAuthState(signingKey, NOW, () => FIXED_STATE);

    expect(
      await consumeOAuthState(
        () => issued.cookieValue,
        FIXED_STATE,
        signingKey,
        NOW + OAUTH_STATE_TTL_SECONDS
      )
    ).toBe(false);
  });

  test('一度消費した Cookie は再利用できない', async () => {
    const issued = await createOAuthState(signingKey, NOW, () => FIXED_STATE);
    let cookie: string | undefined = issued.cookieValue;
    const takeCookie = (): string | undefined => {
      const value = cookie;
      cookie = undefined;
      return value;
    };

    expect(await consumeOAuthState(takeCookie, FIXED_STATE, signingKey, NOW)).toBe(true);
    expect(await consumeOAuthState(takeCookie, FIXED_STATE, signingKey, NOW)).toBe(false);
  });
});

describe('requireUser', () => {
  test('Cookie がなければ 401 を返す', async () => {
    const db = new FakeUsersDatabase(null);

    const result = await requireUser(new Request('https://example.test/api/me/'), {
      db,
      signingKey,
      nowSeconds: NOW,
    });

    expect(result).toEqual({
      ok: false,
      status: 401,
      error: { errorCode: 'UNAUTHORIZED', message: '認証が必要です' },
    });
    expect(db.prepareCount).toBe(0);
  });

  test('有効な Cookie なら D1 のユーザーを返す', async () => {
    const db = new FakeUsersDatabase({
      id: 42,
      discord_id: '123456789',
      name: 'WebScreen User',
      avatar: 'avatar-hash',
    });
    const token = await signSession(createSessionPayload(42, NOW), signingKey);
    const request = new Request('https://example.test/api/me/', {
      headers: { Cookie: `other=value; ws_session=${token}` },
    });

    const result = await requireUser(request, { db, signingKey, nowSeconds: NOW });

    expect(result).toEqual({
      ok: true,
      user: {
        id: 42,
        discordId: '123456789',
        name: 'WebScreen User',
        avatar: 'avatar-hash',
      },
    });
    expect(db.boundValues).toEqual([42]);
  });
});

class FakeUsersDatabase implements UsersDatabase {
  prepareCount = 0;
  boundValues: unknown[] = [];

  constructor(private readonly row: Record<string, unknown> | null) {}

  prepare(): UserStatement {
    this.prepareCount += 1;
    return {
      bind: (...values: unknown[]) => {
        this.boundValues = values;
        return this.prepare();
      },
      first: async <T>() => this.row as T | null,
    };
  }
}
