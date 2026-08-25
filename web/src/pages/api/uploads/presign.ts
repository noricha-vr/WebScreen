import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { ERROR_CODES, type ErrorResponse, validatePresignRequest } from '../../../lib/contracts/api';
import { importSigningKey, SESSION_COOKIE_NAME, verifySession } from '../../../lib/contracts/session';
import {
  createPendingUpload,
  createR2UploadUrlGenerator,
  UploadError,
  type UploadBucket,
  type UploadDatabase,
} from '../../../lib/services/uploads';

export const prerender = false;

interface UploadBindings {
  DB: UploadDatabase;
  BUCKET: UploadBucket;
  SESSION_SIGNING_KEY: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_PUBLIC_BASE_URL: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

/** pending movie を予約し、R2 への直接 PUT URL を払い出す。 */
export const POST: APIRoute = async ({ request }) => {
  const userId = await requireLocalUser(request);
  if (userId === null) return errorResponse(401, ERROR_CODES.unauthorized, '認証が必要です');

  const validation = validatePresignRequest(await readJson(request));
  if (!validation.ok) return json(validation.error, 400);

  const bindings = env as unknown as UploadBindings;
  try {
    const response = await createPendingUpload({
      database: bindings.DB,
      userId,
      request: validation.value,
      publicBaseUrl: bindings.R2_PUBLIC_BASE_URL,
      createUploadUrl: createR2UploadUrlGenerator({
        accountId: bindings.R2_ACCOUNT_ID,
        bucketName: bindings.R2_BUCKET_NAME,
        accessKeyId: bindings.R2_ACCESS_KEY_ID,
        secretAccessKey: bindings.R2_SECRET_ACCESS_KEY,
      }),
    });
    return json(response, 200);
  } catch (error) {
    return uploadErrorResponse(error);
  }
};

// TODO(lead,2026-08-25): auth.ts の requireUser 実装に統合する。
async function requireLocalUser(request: Request): Promise<number | null> {
  const token = readCookie(request.headers.get('Cookie'), SESSION_COOKIE_NAME);
  if (!token) return null;

  const bindings = env as unknown as UploadBindings;
  const key = await importSigningKey(bindings.SESSION_SIGNING_KEY);
  return (await verifySession(token, key))?.uid ?? null;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const prefix = `${name}=`;
  const value = header.split(';').map((part) => part.trim()).find((part) => part.startsWith(prefix));
  if (!value) return null;
  try {
    return decodeURIComponent(value.slice(prefix.length));
  } catch {
    return null;
  }
}

function uploadErrorResponse(error: unknown): Response {
  if (error instanceof UploadError) return errorResponse(error.status, error.errorCode, error.message);
  return errorResponse(500, ERROR_CODES.internalError, 'アップロードURLの発行に失敗しました');
}

function errorResponse(status: number, errorCode: ErrorResponse['errorCode'], message: string): Response {
  return json({ errorCode, message }, status);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
