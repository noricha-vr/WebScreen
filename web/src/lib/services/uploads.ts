import {
  ERROR_CODES,
  type PresignRequest,
  type PresignResponse,
} from '../contracts/api';
import { generateShortId, movieUrl, temporaryUploadKey } from '../contracts/r2key';
import { createR2PutPresignedUrl, type R2PresignConfig } from '../infra/r2presign';
import { logWorkerFailure } from '../infra/worker-log';
import {
  getUserUploadQuota,
  MAX_PENDING_UPLOADS_PER_USER,
  MOVIE_RETENTION_MS,
  USER_STORAGE_QUOTA_BYTES,
} from './quota';
import { UploadError, type UploadDatabase } from './upload-types';

export type { UploadBucket } from './upload-objects';
export { commitUpload, type CommitUploadInput } from './upload-commit';
export { UploadError, type UploadDatabase } from './upload-types';

/** R2 URL 発行をテストから差し替えるための境界。 */
export type UploadUrlGenerator = (key: string) => Promise<string>;

export interface CreatePendingUploadInput {
  database: UploadDatabase;
  userId: number;
  request: PresignRequest;
  publicBaseUrl: string;
  createUploadUrl: UploadUrlGenerator;
  generateId?: () => string;
  now?: Date;
}

/** 未確定アップロードを所有者条件付きで failed にする入力。 */
export interface AbandonUploadInput {
  database: UploadDatabase;
  userId: number;
  shortId: string;
}

/** R2 署名設定から、サービスへ注入する PUT URL 発行器を作る。 */
export function createR2UploadUrlGenerator(config: R2PresignConfig): UploadUrlGenerator {
  return (key) => createR2PutPresignedUrl(config, key);
}

/** movies に pending 行を予約し、直接 PUT 用 URL を返す。 */
export async function createPendingUpload(
  input: CreatePendingUploadInput
): Promise<PresignResponse> {
  const shortId = (input.generateId ?? generateShortId)();
  const key = temporaryUploadKey(shortId);

  // URL の発行を INSERT より先に行う。逆順だと発行に失敗した時に pending 行だけが残り、
  // 署名失効後の回収が拾うまで保存容量を食い続ける（利用者からは理由が見えない）。
  // 先に発行して失敗すれば行を作らずに終わる。行の無い署名 URL は呼び出し元へ返らない
  // ので PUT されず、R2 にも D1 にも何も残らない。
  const uploadUrl = await input.createUploadUrl(key);

  const expiresAt = new Date(
    (input.now ?? new Date()).getTime() + MOVIE_RETENTION_MS
  ).toISOString();
  // 容量判定を INSERT と同じ SQL 文へ入れる。先に使用量を読んでから INSERT すると、
  // 並行リクエストが同じ残量を見て両方通り、予約合計が上限を超える。SQLite/D1 は
  // 1 文の書き込みを直列化するため、後から実行された INSERT は先行予約を含めて判定する。
  const reservation = await input.database
    .prepare(
      `INSERT INTO movies (short_id, user_id, filename, size_bytes, status, expires_at)
       SELECT ?, ?, ?, ?, 'pending', ?
       WHERE COALESCE((
         SELECT SUM(size_bytes) FROM movies
         WHERE user_id = ? AND status IN ('pending', 'ready', 'failed')
       ), 0) + ? <= ?
       AND (SELECT COUNT(*) FROM movies WHERE user_id = ? AND status = 'pending') < ?`
    )
    .bind(
      shortId,
      input.userId,
      input.request.filename,
      input.request.sizeBytes,
      expiresAt,
      input.userId,
      input.request.sizeBytes,
      USER_STORAGE_QUOTA_BYTES,
      input.userId,
      MAX_PENDING_UPLOADS_PER_USER
    )
    .run();
  if (reservation.meta.changes === 0) {
    const quota = await getUserUploadQuota(input.database, input.userId);
    if (quota.pendingUploads >= MAX_PENDING_UPLOADS_PER_USER) {
      throw new UploadError(
        429,
        ERROR_CODES.tooManyPendingUploads,
        '同時に予約できるアップロード数の上限に達しました'
      );
    }
    throw new UploadError(
      413,
      ERROR_CODES.payloadTooLarge,
      '保存容量の上限を超えるためアップロードできません'
    );
  }

  return {
    shortId,
    uploadUrl,
    publicUrl: movieUrl(input.publicBaseUrl, shortId),
  };
}

/** 所有者の未確定アップロードを failed にし、保持期間バッチへ回収を委ねる。 */
export async function abandonUpload(input: AbandonUploadInput): Promise<void> {
  try {
    await input.database
      .prepare(
        "UPDATE movies SET status = 'failed' WHERE short_id = ? AND user_id = ? AND status = 'pending'"
      )
      .bind(input.shortId, input.userId)
      .run();
  } catch (error) {
    logWorkerFailure({
      event: 'upload_abandon_failed',
      errorCode: ERROR_CODES.internalError,
      status: 500,
      errorName: error instanceof Error ? error.name : undefined,
    });
    throw error;
  }
}
