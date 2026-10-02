import { ERROR_CODES, MAX_UPLOAD_BYTES, type CommitResponse } from '../contracts/api';
import { movieUrl } from '../contracts/r2key';
import { logWorkerFailure } from '../observability/worker-log';
import { purgeMovieCache, type CachePurgeSettings } from './cache-purge';
import { USER_STORAGE_QUOTA_BYTES } from './quota';
import {
  getTemporaryUpload,
  publishTemporaryUpload,
  tryDeletePublishedUpload,
  tryDeleteTemporaryUpload,
  type UploadBucket,
} from './upload-objects';
import { UploadError, type UploadDatabase } from './upload-types';
import { recordUsageEvent } from './usage-log';

interface MovieRow {
  short_id: string;
  user_id: number;
  size_bytes: number;
  status: 'pending' | 'ready' | 'failed';
  expires_at: string | null;
  /** 変換元の種別。migration 0006 より前の行は null。 */
  kind: string | null;
}

/** upload commit に必要な D1・R2 と所有者情報。 */
export interface CommitUploadInput {
  database: UploadDatabase;
  bucket: UploadBucket;
  userId: number;
  shortId: string;
  publicBaseUrl: string;
  cachePurge: CachePurgeSettings;
}

/** 一時 R2 実体を検証し、所有者の pending movie を ready に確定する。 */
export async function commitUpload(input: CommitUploadInput): Promise<CommitResponse> {
  const movie = await findMovie(input.database, input.userId, input.shortId);
  if (!movie) throw new UploadError(404, ERROR_CODES.notFound, '対象の動画が見つかりません');

  if (movie.status === 'ready') {
    await tryDeleteTemporaryUpload(input.bucket, input.shortId);
    return toCommitResponse(movie, input.publicBaseUrl);
  }
  if (movie.status !== 'pending') {
    throw new UploadError(400, ERROR_CODES.invalidRequest, 'この動画は commit できません');
  }
  return commitPendingUpload(input, movie);
}

async function commitPendingUpload(
  input: CommitUploadInput,
  movie: MovieRow
): Promise<CommitResponse> {
  const object = await getTemporaryUpload(input.bucket, input.shortId);
  if (!object) {
    throw new UploadError(400, ERROR_CODES.invalidRequest, 'アップロード済みの動画が見つかりません');
  }

  if (object.size > MAX_UPLOAD_BYTES || object.size > movie.size_bytes * 2) {
    return rejectOversizedUpload(input, object.size);
  }

  const published = await publishTemporaryUpload(input.bucket, input.shortId, object.body);
  if (!published) throw new Error('published upload disappeared after conditional put');
  if (published.size > MAX_UPLOAD_BYTES || published.size > movie.size_bytes * 2) {
    return resolvePublishedConflict(input, published.size);
  }
  return finalizePublishedUpload(input, movie, published.size);
}

async function finalizePublishedUpload(
  input: CommitUploadInput,
  movie: MovieRow,
  actualSize: number
): Promise<CommitResponse> {
  const updated = await input.database
    .prepare(
      `UPDATE movies SET status = 'ready', size_bytes = ?
       WHERE short_id = ? AND user_id = ? AND status = 'pending'
       AND COALESCE((
         SELECT SUM(size_bytes) FROM movies
         WHERE user_id = ? AND short_id <> ? AND status IN ('pending', 'ready', 'failed')
       ), 0) + ? <= ?`
    )
    .bind(
      actualSize,
      input.shortId,
      input.userId,
      input.userId,
      input.shortId,
      actualSize,
      USER_STORAGE_QUOTA_BYTES
    )
    .run();

  if (updated.meta.changes === 0) return resolvePublishedConflict(input, actualSize);
  await tryDeleteTemporaryUpload(input.bucket, input.shortId);
  // 公開できた動画だけを利用ログに残す（行が 30 日で消えても「誰が何を変換したか」は残る）。
  await recordUsageEvent(input.database, {
    userId: input.userId,
    event: 'movie_ready',
    shortId: input.shortId,
    kind: movie.kind,
    sizeBytes: actualSize,
  });
  return toCommitResponse({ ...movie, size_bytes: actualSize, status: 'ready' }, input.publicBaseUrl);
}

async function resolvePublishedConflict(
  input: CommitUploadInput,
  actualSize: number
): Promise<CommitResponse> {
  let current = await findMovie(input.database, input.userId, input.shortId);
  if (current?.status === 'pending') {
    if (await claimOversizedUpload(input, actualSize)) {
      await cleanupPublishedUpload(input);
      throw oversizedUploadError();
    }
    current = await findMovie(input.database, input.userId, input.shortId);
  }

  if (current?.status !== 'ready') {
    await cleanupPublishedUpload(input);
  } else {
    await tryDeleteTemporaryUpload(input.bucket, input.shortId);
  }
  return resolveCurrentMovie(current, input.publicBaseUrl);
}

/** 公開コピーを消せたときだけ、配信キャッシュも無効にする。 */
async function cleanupPublishedUpload(input: CommitUploadInput): Promise<void> {
  if (await tryDeletePublishedUpload(input.bucket, input.shortId)) {
    await purgeMovieCache([input.shortId], input.cachePurge);
  }
}

async function rejectOversizedUpload(
  input: CommitUploadInput,
  actualSize: number
): Promise<CommitResponse> {
  if (await claimOversizedUpload(input, actualSize)) throw oversizedUploadError();
  const current = await findMovie(input.database, input.userId, input.shortId);
  return resolveCurrentMovie(current, input.publicBaseUrl);
}

/** 上限超過の pending を failed へ確保し、実測サイズを容量へ計上する。 */
async function claimOversizedUpload(input: CommitUploadInput, actualSize: number): Promise<boolean> {
  const claim = await input.database
    .prepare(
      "UPDATE movies SET status = 'failed', size_bytes = ? WHERE short_id = ? AND user_id = ? AND status = 'pending'"
    )
    .bind(actualSize, input.shortId, input.userId)
    .run();
  if (claim.meta.changes > 0) return true;

  logWorkerFailure({
    level: 'warn',
    event: 'upload_commit_oversize_claim_missed',
    errorCode: ERROR_CODES.payloadTooLarge,
    status: 413,
  });
  return false;
}

function oversizedUploadError(): UploadError {
  return new UploadError(
    413,
    ERROR_CODES.payloadTooLarge,
    'アップロード済み動画が保存上限を超えています'
  );
}

function resolveCurrentMovie(movie: MovieRow | null, publicBaseUrl: string): CommitResponse {
  if (!movie) throw new UploadError(404, ERROR_CODES.notFound, '対象の動画が見つかりません');
  if (movie.status === 'ready') return toCommitResponse(movie, publicBaseUrl);
  throw new UploadError(400, ERROR_CODES.invalidRequest, 'この動画は commit できません');
}

async function findMovie(
  database: UploadDatabase,
  userId: number,
  shortId: string
): Promise<MovieRow | null> {
  return database
    .prepare(
      'SELECT short_id, user_id, size_bytes, status, expires_at, kind FROM movies WHERE short_id = ? AND user_id = ?'
    )
    .bind(shortId, userId)
    .first<MovieRow>();
}

function toCommitResponse(movie: MovieRow, publicBaseUrl: string): CommitResponse {
  return {
    shortId: movie.short_id,
    publicUrl: movieUrl(publicBaseUrl, movie.short_id),
    sizeBytes: movie.size_bytes,
    expiresAt: movie.expires_at,
  };
}
