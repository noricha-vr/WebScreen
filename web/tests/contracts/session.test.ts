import { beforeAll, describe, expect, test } from 'bun:test';

import {
  SESSION_TTL_SECONDS,
  createSessionPayload,
  generateOAuthState,
  importSigningKey,
  matchesOAuthState,
  signSession,
  verifySession,
} from '../../src/lib/contracts/session';

// テスト用のダミー鍵。本番は Cloudflare Secret（SESSION_SIGNING_KEY）から渡す。
const NOW = 1_700_000_000;

let key: CryptoKey;
let otherKey: CryptoKey;

beforeAll(async () => {
  key = await importSigningKey('test-signing-key');
  otherKey = await importSigningKey('another-signing-key');
});

describe('signSession / verifySession', () => {
  test('署名した payload を復元できる', async () => {
    const payload = createSessionPayload(42, NOW);

    const token = await signSession(payload, key);

    expect(await verifySession(token, key, NOW)).toEqual(payload);
  });

  test('payload を改竄した Cookie を拒否する', async () => {
    const token = await signSession(createSessionPayload(42, NOW), key);
    const forgedPayload = base64Url(
      new TextEncoder().encode(JSON.stringify({ uid: 1, exp: NOW + 60 }))
    );
    const [, signature] = token.split('.');

    expect(await verifySession(`${forgedPayload}.${signature}`, key, NOW)).toBeNull();
  });

  test('署名を差し替えた Cookie を拒否する', async () => {
    const token = await signSession(createSessionPayload(42, NOW), key);
    const [payload] = token.split('.');

    expect(await verifySession(`${payload}.YWJjZGVm`, key, NOW)).toBeNull();
  });

  test('別の鍵で署名された Cookie を拒否する', async () => {
    const token = await signSession(createSessionPayload(42, NOW), otherKey);

    expect(await verifySession(token, key, NOW)).toBeNull();
  });

  test('有効期限が切れた Cookie を拒否する', async () => {
    const token = await signSession(createSessionPayload(42, NOW), key);

    expect(await verifySession(token, key, NOW + SESSION_TTL_SECONDS + 1)).toBeNull();
  });

  test.each([
    ['セパレータなし', 'abcdef'],
    ['セパレータ過多', 'a.b.c'],
    ['空の署名', 'abcdef.'],
    ['空文字', ''],
  ])('形式が不正な Cookie を拒否する: %s', async (_label, token) => {
    expect(await verifySession(token, key, NOW)).toBeNull();
  });

  test('uid が欠けた payload を拒否する（署名は正しくても中身を信用しない）', async () => {
    const token = await signArbitraryPayload({ exp: NOW + 60 }, key);

    expect(await verifySession(token, key, NOW)).toBeNull();
  });
});

/** 型に合わない payload へ正しい署名を付ける（検証側が中身も見ているかを確かめるため）。 */
async function signArbitraryPayload(payload: unknown, signingKey: CryptoKey): Promise<string> {
  const encoder = new TextEncoder();
  const encodedPayload = base64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(encodedPayload));
  return `${encodedPayload}.${base64Url(new Uint8Array(signature))}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('createSessionPayload', () => {
  test('exp は発行時刻の 30 日後', () => {
    expect(createSessionPayload(7, NOW)).toEqual({ uid: 7, exp: NOW + SESSION_TTL_SECONDS });
  });
});

describe('OAuth state', () => {
  test('生成した state は毎回異なる', () => {
    expect(generateOAuthState()).not.toBe(generateOAuthState());
  });

  test('同じ state は一致する', () => {
    const state = generateOAuthState();

    expect(matchesOAuthState(state, state)).toBe(true);
  });

  test('1 文字でも違う state は一致しない', () => {
    expect(matchesOAuthState('abcdef', 'abcdeF')).toBe(false);
  });

  test.each([
    ['長さ違い', 'abcdef', 'abcde'],
    ['空の Cookie', '', ''],
  ])('%s は一致しない', (_label, cookieState, callbackState) => {
    expect(matchesOAuthState(cookieState, callbackState)).toBe(false);
  });
});
