import { beforeAll, describe, expect, it } from 'bun:test';

import { createStreamJwtKeySet } from '../../src/lib/services/stream-jwt';
import { generateTestPrivateKeyBase64 } from './helpers/stream-keys';

let testPrivateKey: string;

beforeAll(async () => {
  testPrivateKey = await generateTestPrivateKeyBase64();
});

describe('MediaMTX publish JWT', () => {
  it('JWKSに秘密要素を含めず、公開JWKでRS256署名を検証できる', async () => {
    const keySet = await createStreamJwtKeySet(testPrivateKey);
    const token = await keySet.signer({
      pathId: 'AbCdEf123456',
      issuedAtSeconds: 1_788_220_800,
      expiresAtSeconds: 1_788_228_000,
    });
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const publicJwk = keySet.jwks.keys[0]!;

    expect(publicJwk).toMatchObject({ kty: 'RSA', alg: 'RS256', use: 'sig' });
    for (const privateField of ['d', 'p', 'q', 'dp', 'dq', 'qi']) {
      expect(privateField in publicJwk).toBe(false);
    }
    expect(decodeJson(payload)).toEqual({
      mediamtx_permissions: [{ action: 'publish', path: 'live/AbCdEf123456' }],
      iat: 1_788_220_800,
      exp: 1_788_228_000,
    });
    expect(decodeJson(header)).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: publicJwk.kid });

    const key = await crypto.subtle.importKey(
      'jwk',
      publicJwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    expect(
      await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        decodeBase64Url(signature),
        new TextEncoder().encode(`${header}.${payload}`)
      )
    ).toBe(true);
  });
});

function decodeJson(value: string): unknown {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
