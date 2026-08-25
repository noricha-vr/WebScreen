import {
  ERROR_CODES,
  MAX_UPLOAD_BYTES,
  type CommitResponse,
  type ErrorCode,
  type PresignRequest,
  type PresignResponse,
} from '../contracts/api';
import { generateShortId, movieKey } from '../contracts/r2key';
import { createR2PutPresignedUrl, type R2PresignConfig } from '../infra/r2presign';
import {
  exceedsStorageQuota,
  getUserStorageUsage,
  MOVIE_RETENTION_MS,
  type QuotaDatabase,
} from './quota';

/** D1 の更新まで含む、アップロードサービスが必要とする最小の操作面。 */
export interface UploadDatabase extends QuotaDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

/** R2 の commit 確認に必要な最小操作面。 */
export interface UploadBucket {
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
}

/** R2 URL 発行をテストから差し替えるための境界。 */
export type UploadUrlGenerator = (key: string) => Promise<string>;

/** API ハンドラが HTTP 応答へ変換するドメインエラー。 */
export class UploadError extends Error {
  constructor(
    public readonly status: 400 | 404 | 413,
    public readonly errorCode: ErrorCode,
    message: string
  ) {
    super(message);
  }
}

interface MovieRow {
  short_id: string;
  user_id: number;
  size_bytes: number;
  status: 'pending' | 'ready' | 'failed';
  expires_at: string | null;
}

export interface CreatePendingUploadInput {
  database: UploadDatabase;
  userId: number;
  request: PresignRequest;
  publicBaseUrl: string;
  createUploadUrl: UploadUrlGenerator;
  generateId?: () => string;
  now?: Date;
}

export interface CommitUploadInput {
  database: UploadDatabase;
  bucket: UploadBucket;
  userId: number;
  shortId: string;
  publicBaseUrl: string;
}

/** R2 署名設定から、サービスへ注入する PUT URL 発行器を作る。 */
export function createR2UploadUrlGenerator(config: R2PresignConfig): UploadUrlGenerator {
  return (key) => createR2PutPresignedUrl(config, key);
}

/** movies に pending 行を予約し、直接 PUT 用 URL を返す。 */
export async function createPendingUpload(
  input: CreatePendingUploadInput
): Promise<PresignResponse> {
  const usedBytes = await getUserStorageUsage(input.database, input.userId);
  if (exceedsStorageQuota(usedBytes, input.request.sizeBytes)) {
    throw new UploadError(
      413,
      ERROR_CODES.payloadTooLarge,
      '保存容量の上限を超えるためアップロードできません'
    );
  }

  const shortId = (input.generateId ?? generateShortId)();
  const expiresAt = new Date(
    (input.now ?? new Date()).getTime() + MOVIE_RETENTION_MS
  ).toISOString();
  await input.database
    .prepare(
      "INSERT INTO movies (short_id, user_id, filename, size_bytes, status, expires_at) VALUES (?, ?, ?, ?, 'pending', ?)"
    )
    .bind(shortId, input.userId, input.request.filename, input.request.sizeBytes, expiresAt)
    .run();

  const key = movieKey(shortId);
  return {
    shortId,
    uploadUrl: await input.createUploadUrl(key),
    publicUrl: createPublicUrl(input.publicBaseUrl, key),
  };
}

/** R2 実体を検証し、所有者の pending movie を ready に確定する。 */
export async function commitUpload(input: CommitUploadInput): Promise<CommitResponse> {
  const movie = await input.database
    .prepare(
      'SELECT short_id, user_id, size_bytes, status, expires_at FROM movies WHERE short_id = ? AND user_id = ?'
    )
    .bind(input.shortId, input.userId)
    .first<MovieRow>();

  if (!movie) {
    throw new UploadError(404, ERROR_CODES.notFound, '対象の動画が見つかりません');
  }

  const key = movieKey(input.shortId);
  if (movie.status === 'ready') return toCommitResponse(movie, input.publicBaseUrl);
  if (movie.status !== 'pending') {
    throw new UploadError(400, ERROR_CODES.invalidRequest, 'この動画は commit できません');
  }

  const object = await input.bucket.head(key);
  if (!object) {
    throw new UploadError(400, ERROR_CODES.invalidRequest, 'アップロード済みの動画が見つかりません');
  }

  const usageBeforeCommit = await getUserStorageUsage(input.database, input.userId);
  const exceedsPerFileLimit = object.size > MAX_UPLOAD_BYTES;
  const exceedsDeclaredSizeLimit = object.size > movie.size_bytes * 2;
  const exceedsUserLimit = exceedsStorageQuota(
    usageBeforeCommit - movie.size_bytes,
    object.size
  );
  if (exceedsPerFileLimit || exceedsDeclaredSizeLimit || exceedsUserLimit) {
    await input.bucket.delete(key);
    await input.database
      .prepare(
        "UPDATE movies SET status = 'failed' WHERE short_id = ? AND user_id = ? AND status = 'pending'"
      )
      .bind(input.shortId, input.userId)
      .run();
    throw new UploadError(
      413,
      ERROR_CODES.payloadTooLarge,
      'アップロード済み動画が保存上限を超えています'
    );
  }

  await input.database
    .prepare(
      "UPDATE movies SET status = 'ready', size_bytes = ? WHERE short_id = ? AND user_id = ? AND status = 'pending'"
    )
    .bind(object.size, input.shortId, input.userId)
    .run();

  return toCommitResponse({ ...movie, size_bytes: object.size, status: 'ready' }, input.publicBaseUrl);
}

function createPublicUrl(publicBaseUrl: string, key: string): string {
  return new URL(key, `${publicBaseUrl}/`).toString();
}

function toCommitResponse(movie: MovieRow, publicBaseUrl: string): CommitResponse {
  return {
    shortId: movie.short_id,
    publicUrl: createPublicUrl(publicBaseUrl, movieKey(movie.short_id)),
    sizeBytes: movie.size_bytes,
    expiresAt: movie.expires_at,
  };
}
