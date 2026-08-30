import { afterEach, beforeAll, describe, expect, test } from 'bun:test';

import {
  createSessionPayload,
  importSigningKey,
  signSession,
} from '../../src/lib/contracts/session';
import { resolvePreviewOwner } from '../../src/lib/services/auth';
import type { UserStatement, UsersDatabase } from '../../src/lib/infra/users';

const NOW = 1_700_000_000;
const SIGNING_SECRET = 'test-signing-key';
const OWNER_ID = 42;

let signingKey: CryptoKey;

beforeAll(async () => {
  signingKey = await importSigningKey(SIGNING_SECRET);
});

function requestWithCookie(token: string): Request {
  return new Request('https://example.test/AbCdEf123456/', {
    headers: { Cookie: `ws_session=${token}` },
  });
}

async function sessionCookieFor(userId: number): Promise<string> {
  return signSession(createSessionPayload(userId, NOW), signingKey);
}

const originalConsoleError = console.error;
const errors: string[] = [];

/** logWorkerFailure は console.error の 1 行 JSON なので、そこから event を読む。 */
function captureWorkerLog(): void {
  errors.length = 0;
  console.error = (entry: unknown) => {
    errors.push(String(entry));
  };
}

afterEach(() => {
  console.error = originalConsoleError;
});

describe('resolvePreviewOwner', () => {
  test('Cookie が無ければ D1 にも鍵にも触らず非所有者にする', async () => {
    captureWorkerLog();
    const db = new ThrowingUsersDatabase();

    const result = await resolvePreviewOwner(new Request('https://example.test/AbCdEf123456/'), {
      db,
      signingKeySecret: '',
      ownerId: OWNER_ID,
      nowSeconds: NOW,
    });

    expect(result).toEqual({ ok: true, isOwner: false });
    expect(db.prepareCount).toBe(0);
    expect(errors).toHaveLength(0);
  });

  test('所有者のセッションなら所有者と判定する', async () => {
    const db = new FakeUsersDatabase({
      id: OWNER_ID,
      discord_id: '123456789',
      name: 'WebScreen User',
      avatar: null,
    });

    const result = await resolvePreviewOwner(
      requestWithCookie(await sessionCookieFor(OWNER_ID)),
      { db, signingKeySecret: SIGNING_SECRET, ownerId: OWNER_ID, nowSeconds: NOW }
    );

    expect(result).toEqual({ ok: true, isOwner: true });
  });

  test('別のユーザーのセッションは非所有者にする', async () => {
    const db = new FakeUsersDatabase({
      id: 7,
      discord_id: '987654321',
      name: 'Someone Else',
      avatar: null,
    });

    const result = await resolvePreviewOwner(requestWithCookie(await sessionCookieFor(7)), {
      db,
      signingKeySecret: SIGNING_SECRET,
      ownerId: OWNER_ID,
      nowSeconds: NOW,
    });

    expect(result).toEqual({ ok: true, isOwner: false });
  });

  test('署名が通らない Cookie は非所有者にする（基盤の異常ではない）', async () => {
    const db = new FakeUsersDatabase(null);

    const result = await resolvePreviewOwner(requestWithCookie('tampered.value'), {
      db,
      signingKeySecret: SIGNING_SECRET,
      ownerId: OWNER_ID,
      nowSeconds: NOW,
    });

    expect(result).toEqual({ ok: true, isOwner: false });
  });

  test('署名鍵が壊れていれば失敗として返す', async () => {
    captureWorkerLog();
    const db = new FakeUsersDatabase(null);

    const result = await resolvePreviewOwner(requestWithCookie(await sessionCookieFor(OWNER_ID)), {
      db,
      signingKeySecret: '',
      ownerId: OWNER_ID,
      nowSeconds: NOW,
    });

    expect(result).toEqual({ ok: false });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('preview_owner_check_failed');
  });

  test('D1 が落ちていれば失敗として返す（他人の動画にしない）', async () => {
    captureWorkerLog();
    const db = new ThrowingUsersDatabase();

    const result = await resolvePreviewOwner(requestWithCookie(await sessionCookieFor(OWNER_ID)), {
      db,
      signingKeySecret: SIGNING_SECRET,
      ownerId: OWNER_ID,
      nowSeconds: NOW,
    });

    expect(result).toEqual({ ok: false });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('preview_owner_check_failed');
  });
});

class FakeUsersDatabase implements UsersDatabase {
  constructor(private readonly row: Record<string, unknown> | null) {}

  prepare(): UserStatement {
    const statement: UserStatement = {
      bind: () => statement,
      first: async <T>() => this.row as T | null,
    };
    return statement;
  }
}

/** D1 障害の再現。参照されたら必ず throw する。 */
class ThrowingUsersDatabase implements UsersDatabase {
  prepareCount = 0;

  prepare(): UserStatement {
    this.prepareCount += 1;
    throw new Error('D1_ERROR: network error');
  }
}
