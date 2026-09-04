import type { CaptureResponse, CommitResponse, PresignResponse } from '../contracts/api';
import { isShortId } from '../contracts/r2key';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** presign API の成功応答を検証する。 */
export function asPresignResponse(value: unknown): PresignResponse {
  if (!isRecord(value) || typeof value.shortId !== 'string' ||
      typeof value.uploadUrl !== 'string' || typeof value.publicUrl !== 'string') {
    throw new Error('Invalid presign response');
  }
  return { shortId: value.shortId, uploadUrl: value.uploadUrl, publicUrl: value.publicUrl };
}

/** commit API の成功応答を検証する。 */
export function asCommitResponse(value: unknown): CommitResponse {
  if (!isRecord(value) || typeof value.shortId !== 'string' || !isShortId(value.shortId) ||
      typeof value.publicUrl !== 'string' || typeof value.sizeBytes !== 'number' ||
      (typeof value.expiresAt !== 'string' && value.expiresAt !== null)) {
    throw new Error('Invalid commit response');
  }
  return {
    shortId: value.shortId,
    publicUrl: value.publicUrl,
    sizeBytes: value.sizeBytes,
    expiresAt: value.expiresAt,
  };
}

/** capture API の成功応答を検証する。 */
export function asCaptureResponse(value: unknown): CaptureResponse {
  if (!isRecord(value) || !Array.isArray(value.images) ||
      value.images.some((image) => typeof image !== 'string')) {
    throw new Error('Invalid capture response');
  }
  const images = value.images as string[];
  // totalImages のない旧応答は、返った画像をページ全体として扱う。
  if (value.totalImages === undefined) return { images, totalImages: images.length };
  if (!Number.isSafeInteger(value.totalImages) || (value.totalImages as number) < 0) {
    throw new Error('Invalid capture response');
  }
  return { images, totalImages: value.totalImages as number };
}
