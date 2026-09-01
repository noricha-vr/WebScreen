import type { StreamJwtSigner } from './streams';

const encoder = new TextEncoder();
const SIGNING_ALGORITHM = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

export interface StreamJwtKeySet {
  signer: StreamJwtSigner;
  jwks: { keys: PublicJwk[] };
}

export interface PublicJwk extends JsonWebKey {
  kid: string;
  alg: 'RS256';
  use: 'sig';
}

/** Base64 PKCS#8（または PEM）秘密鍵から publish JWT signer と公開 JWKS を作る。 */
export async function createStreamJwtKeySet(secret: string): Promise<StreamJwtKeySet> {
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    decodePkcs8(secret),
    SIGNING_ALGORITHM,
    true,
    ['sign']
  );
  const privateJwk = await crypto.subtle.exportKey('jwk', privateKey);
  if (!privateJwk.n || !privateJwk.e || privateJwk.kty !== 'RSA') {
    throw new Error('STREAM_JWT_PRIVATE_KEY is not an RSA private key');
  }

  const kid = await jwkThumbprint(privateJwk);
  const publicJwk: PublicJwk = {
    kty: 'RSA',
    n: privateJwk.n,
    e: privateJwk.e,
    kid,
    alg: 'RS256',
    use: 'sig',
    key_ops: ['verify'],
  };

  return {
    signer: async ({ pathId, issuedAtSeconds, expiresAtSeconds }) => {
      const header = encodeJson({ alg: 'RS256', typ: 'JWT', kid });
      const payload = encodeJson({
        mediamtx_permissions: [{ action: 'publish', path: `live/${pathId}` }],
        iat: issuedAtSeconds,
        exp: expiresAtSeconds,
      });
      const signingInput = `${header}.${payload}`;
      const signature = await crypto.subtle.sign(
        SIGNING_ALGORITHM,
        privateKey,
        encoder.encode(signingInput)
      );
      return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
    },
    jwks: { keys: [publicJwk] },
  };
}

async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n });
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(canonical));
  return base64UrlEncode(new Uint8Array(digest));
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

function decodePkcs8(secret: string): ArrayBuffer {
  const base64 = secret.includes('BEGIN PRIVATE KEY')
    ? secret.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '')
    : secret.replace(/\s/g, '');
  if (!base64) throw new Error('STREAM_JWT_PRIVATE_KEY is empty');
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
