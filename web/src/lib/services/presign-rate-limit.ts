import { ERROR_CODES, type ErrorResponse } from '../contracts/api';

/** 1 ユーザーが 1 ウィンドウ内に発行できる数。wrangler の PRESIGN_LIMITER と同期する。 */
export const PRESIGN_RATE_LIMIT = 10;

/** 固定ウィンドウ（秒）。wrangler の PRESIGN_LIMITER と同期する。 */
export const PRESIGN_RATE_LIMIT_PERIOD_SECONDS = 60;

/** Workers の Rate Limiting binding のうち presign が使う操作面。 */
export interface PresignRateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** ユーザー単位の presign 上限を検査し、超過時だけ 429 応答を返す。 */
export async function enforcePresignRateLimit(
  limiter: PresignRateLimiter | undefined,
  userId: number
): Promise<Response | null> {
  if (!limiter) throw new Error('PRESIGN_LIMITER binding is required');

  const { success } = await limiter.limit({ key: String(userId) });
  if (success) return null;

  const body: ErrorResponse = {
    errorCode: ERROR_CODES.tooManyPresignRequests,
    message: 'アップロードURLの発行回数が上限を超えました',
  };
  return Response.json(body, {
    status: 429,
    headers: {
      'Cache-Control': 'no-store',
      'Retry-After': String(PRESIGN_RATE_LIMIT_PERIOD_SECONDS),
    },
  });
}
