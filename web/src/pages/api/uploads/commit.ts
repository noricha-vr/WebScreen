import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { ERROR_CODES, type ErrorResponse, validateCommitRequest } from '../../../lib/contracts/api';
import { logWorkerFailure } from '../../../lib/infra/worker-log';
import { importSigningKey } from '../../../lib/contracts/session';
import { requireUser, type AuthDatabase } from '../../../lib/services/auth';
import {
  commitUpload,
  UploadError,
  type UploadBucket,
  type UploadDatabase,
} from '../../../lib/services/uploads';

export const prerender = false;

interface UploadBindings {
  DB: UploadDatabase & AuthDatabase;
  BUCKET: UploadBucket;
  SESSION_SIGNING_KEY: string;
  R2_PUBLIC_BASE_URL: string;
}

/** R2 に存在する動画を確認し、所有者の movie を ready に確定する。 */
export const POST: APIRoute = async ({ request }) => {
  const bindings = env as unknown as UploadBindings;
  const signingKey = await importSigningKey(bindings.SESSION_SIGNING_KEY);
  const authenticated = await requireUser(request, { db: bindings.DB, signingKey });
  if (!authenticated.ok) return json(authenticated.error, authenticated.status);

  const validation = validateCommitRequest(await readJson(request));
  if (!validation.ok) return json(validation.error, 400);

  try {
    const response = await commitUpload({
      database: bindings.DB,
      bucket: bindings.BUCKET,
      userId: authenticated.user.id,
      shortId: validation.value.shortId,
      publicBaseUrl: bindings.R2_PUBLIC_BASE_URL,
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
  logWorkerFailure({ event: 'upload_commit_failed', errorCode: ERROR_CODES.internalError, status: 500 });
  return errorResponse(500, ERROR_CODES.internalError, 'アップロードの確定に失敗しました');
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
