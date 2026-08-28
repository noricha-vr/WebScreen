import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { ERROR_CODES, type ErrorResponse, validatePresignRequest } from '../../../lib/contracts/api';
import { logWorkerFailure } from '../../../lib/infra/worker-log';
import { importSigningKey } from '../../../lib/contracts/session';
import { requireUser, type AuthDatabase } from '../../../lib/services/auth';
import {
  createPendingUpload,
  createR2UploadUrlGenerator,
  UploadError,
  type UploadBucket,
  type UploadDatabase,
} from '../../../lib/services/uploads';

export const prerender = false;

interface UploadBindings {
  DB: UploadDatabase & AuthDatabase;
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
  const bindings = env as unknown as UploadBindings;
  const signingKey = await importSigningKey(bindings.SESSION_SIGNING_KEY);
  const authenticated = await requireUser(request, { db: bindings.DB, signingKey });
  if (!authenticated.ok) return json(authenticated.error, authenticated.status);

  const validation = validatePresignRequest(await readJson(request));
  if (!validation.ok) return json(validation.error, 400);

  try {
    const response = await createPendingUpload({
      database: bindings.DB,
      userId: authenticated.user.id,
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

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function uploadErrorResponse(error: unknown): Response {
  if (error instanceof UploadError) return errorResponse(error.status, error.errorCode, error.message);
  logWorkerFailure({ event: 'upload_presign_failed', errorCode: ERROR_CODES.internalError, status: 500 });
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
