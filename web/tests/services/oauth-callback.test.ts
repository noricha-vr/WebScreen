import { describe, expect, test } from 'bun:test';

import { importSigningKey, verifySession } from '../../src/lib/contracts/session';
import { completeDiscordOAuth } from '../../src/lib/services/auth';
import type { Fetcher } from '../../src/lib/infra/discord';
import type { UserStatement, UsersDatabase } from '../../src/lib/infra/users';

const NOW = 1_700_000_000;

describe('completeDiscordOAuth', () => {
  test('Discord identity を users に upsert してセッションを発行する', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: Fetcher = async (input, init) => {
      const url = input.toString();
      requests.push({ url, init });
      if (url.endsWith('/oauth2/token')) {
        return Response.json({ access_token: 'discord-access-token', token_type: 'Bearer' });
      }
      return Response.json({
        id: '987654321',
        username: 'fallback-name',
        global_name: 'Display Name',
        avatar: 'avatar-hash',
      });
    };
    const db = new UpsertDatabase();
    const signingKey = await importSigningKey('test-signing-key');

    const result = await completeDiscordOAuth(
      'authorization-code',
      'https://example.test/api/auth/callback/',
      {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        db,
        signingKey,
        fetcher,
        nowSeconds: NOW,
      }
    );

    expect(db.boundValues).toEqual(['987654321', 'Display Name', 'avatar-hash']);
    expect(result.user).toEqual({
      id: 7,
      discordId: '987654321',
      name: 'Display Name',
      avatar: 'avatar-hash',
    });
    expect(await verifySession(result.sessionCookieValue, signingKey, NOW)).toEqual({
      uid: 7,
      exp: 1_702_592_000,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.init?.headers).toEqual({
      Authorization: 'Bearer discord-access-token',
    });
  });
});

class UpsertDatabase implements UsersDatabase {
  boundValues: unknown[] = [];

  prepare(): UserStatement {
    const statement: UserStatement = {
      bind: (...values: unknown[]) => {
        this.boundValues = values;
        return statement;
      },
      first: async <T>() =>
        ({
          id: 7,
          discord_id: this.boundValues[0],
          name: this.boundValues[1],
          avatar: this.boundValues[2],
        }) as T,
    };
    return statement;
  }
}
