import { movieKey, temporaryUploadKey } from '../contracts/r2key';
import { logUploadCleanupFailure } from '../observability/worker-log';

/** R2 の一時オブジェクト。body はバッファ化せず公開キーへの PUT に渡す。 */
export interface TemporaryUploadObject {
  size: number;
  body: ReadableStream<Uint8Array>;
}

/** R2 が保存済みオブジェクトについて返す、確定処理に必要なメタデータ。 */
export interface PublishedUploadObject {
  size: number;
}

/** アップロードの確定処理が必要とする R2 の最小操作面。 */
export interface UploadBucket {
  get(key: string): Promise<TemporaryUploadObject | null>;
  head(key: string): Promise<PublishedUploadObject | null>;
  put(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: {
      httpMetadata: { contentType: string };
      onlyIf: { etagDoesNotMatch: '*' };
    }
  ): Promise<PublishedUploadObject | null>;
  delete(keys: string | string[]): Promise<void>;
}

/** 公開配信キーと分離した一時キーから、検証対象の実体を取得する。 */
export function getTemporaryUpload(
  bucket: UploadBucket,
  shortId: string
): Promise<TemporaryUploadObject | null> {
  return bucket.get(temporaryUploadKey(shortId));
}

/** 検証済みの stream を公開動画キーへ保存する。 */
export async function publishTemporaryUpload(
  bucket: UploadBucket,
  shortId: string,
  body: ReadableStream<Uint8Array>
): Promise<PublishedUploadObject | null> {
  const key = movieKey(shortId);
  const created = await bucket.put(key, body, {
    httpMetadata: { contentType: 'video/mp4' },
    onlyIf: { etagDoesNotMatch: '*' },
  });
  if (created) return created;
  return bucket.head(key);
}

/** commit 後の一時実体を削除する。 */
export async function tryDeleteTemporaryUpload(
  bucket: UploadBucket,
  shortId: string
): Promise<void> {
  try {
    await bucket.delete(temporaryUploadKey(shortId));
  } catch (error) {
    logCleanupFailure('upload_tmp_cleanup_failed', error);
  }
}

/** ready 化できなかった公開コピーを削除する。 */
export async function tryDeletePublishedUpload(
  bucket: UploadBucket,
  shortId: string
): Promise<void> {
  try {
    await bucket.delete(movieKey(shortId));
  } catch (error) {
    logCleanupFailure('upload_public_cleanup_failed', error);
  }
}

function logCleanupFailure(
  event: 'upload_tmp_cleanup_failed' | 'upload_public_cleanup_failed',
  error: unknown
): void {
  logUploadCleanupFailure({
    event,
    errorName: error instanceof Error ? error.name : undefined,
  });
}
