import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import {
  ERROR_CODES,
  MAX_ABANDON_UPLOAD_BODY_BYTES,
  validateAbandonUploadRequest,
} from '../../../lib/contracts/api';
import { importSigningKey } from '../../../lib/contracts/session';
import { requireUser, type AuthDatabase } from '../../../lib/services/auth';
import { readLimitedJsonBody } from '../../../lib/services/upload-request';
import { abandonUpload, type UploadDatabase } from '../../../lib/services/uploads';

export const prerender = false;

interface AbandonUploadBindings {
  DB: UploadDatabase & AuthDatabase;
  SESSION_SIGNING_KEY: string;
}

/** 所有者の pending アップロードを failed にし、後続の保持期間バッチへ委ねる。 */
export const POST: APIRoute = async ({ request }) => {
  const bindings = env as unknown as AbandonUploadBindings;
  const signingKey = await importSigningKey(bindings.SESSION_SIGNING_KEY);
  const authenticated = await requireUser(request, { db: bindings.DB, signingKey });
  if (!authenticated.ok) return Response.json(authenticated.error, { status: authenticated.status });

  const body = await readLimitedJsonBody(request, MAX_ABANDON_UPLOAD_BODY_BYTES);
  if (!body.ok) return Response.json(body.error, { status: body.status });

  const validation = validateAbandonUploadRequest(body.value);
  if (!validation.ok) return Response.json(validation.error, { status: 400 });

  try {
    await abandonUpload({
      database: bindings.DB,
      userId: authenticated.user.id,
      shortId: validation.value.shortId,
    });
    // pending 以外・他人・不存在でも状態を漏らさず、安全に再試行できる。
    return new Response(null, { status: 204 });
  } catch {
    return Response.json(
      { errorCode: ERROR_CODES.internalError, message: 'アップロードの取り消しに失敗しました' },
      { status: 500 }
    );
  }
};
