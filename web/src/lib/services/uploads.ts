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
import { logWorkerFailure } from '../infra/worker-log';
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
      run(): Promise<{ meta: { changes: number } }>;
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
  const key = movieKey(shortId);

  // URL の発行を INSERT より先に行う。逆順だと発行に失敗した時に pending 行だけが残り、
  // 24 時間の孤児掃除が拾うまで保存容量を食い続ける（利用者からは理由が見えない）。
  // 先に発行して失敗すれば行を作らずに終わる。行の無い署名 URL は呼び出し元へ返らない
  // ので PUT されず、R2 にも D1 にも何も残らない。
  const uploadUrl = await input.createUploadUrl(key);

  const expiresAt = new Date(
    (input.now ?? new Date()).getTime() + MOVIE_RETENTION_MS
  ).toISOString();
  await input.database
    .prepare(
      "INSERT INTO movies (short_id, user_id, filename, size_bytes, status, expires_at) VALUES (?, ?, ?, ?, 'pending', ?)"
    )
    .bind(shortId, input.userId, input.request.filename, input.request.sizeBytes, expiresAt)
    .run();

  return {
    shortId,
    uploadUrl,
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
    await rejectOversizedUpload(input, key);
    throw new UploadError(
      413,
      ERROR_CODES.payloadTooLarge,
      'アップロード済み動画が保存上限を超えています'
    );
  }

  const updated = await input.database
    .prepare(
      "UPDATE movies SET status = 'ready', size_bytes = ? WHERE short_id = ? AND user_id = ? AND status = 'pending'"
    )
    .bind(object.size, input.shortId, input.userId)
    .run();

  // 0 件 = SELECT と R2 確認の間に行が pending でなくなった。成功として返すと、
  // 保持期間バッチが回収した動画の公開 URL を返してしまう（行も実体も無いのに再生できる想定になる）。
  if (updated.meta.changes === 0) return resolveCommitConflict(input);

  return toCommitResponse({ ...movie, size_bytes: object.size, status: 'ready' }, input.publicBaseUrl);
}

/**
 * 上限を超えた動画の予約を failed へ落とし、実体を消す。
 *
 * 保持期間バッチと同じ確保方式（条件付き UPDATE → R2）にする。R2 を先に消すと、
 * 読んでから書くまでの間に別の書き手が同じ行を確定させた時、実体だけが消える。
 * 確保に負けた（0 件）行はこの呼び出しの持ち物ではないので R2 に触らない。
 *
 * 実体の削除に失敗しても 500 にはしない。呼び出し元へ返すべき理由は上限超過であって
 * R2 の障害ではなく、failed のまま残った行は failed の掃除（services/retention.ts）が
 * 同じ順序（R2 → D1）で回収し直すため。どちらの分岐も件数と理由をログに残す。
 */
async function rejectOversizedUpload(input: CommitUploadInput, key: string): Promise<void> {
  const claim = await input.database
    .prepare(
      "UPDATE movies SET status = 'failed' WHERE short_id = ? AND user_id = ? AND status = 'pending'"
    )
    .bind(input.shortId, input.userId)
    .run();

  if (claim.meta.changes === 0) {
    logWorkerFailure({
      level: 'warn',
      event: 'upload_commit_oversize_claim_missed',
      errorCode: ERROR_CODES.payloadTooLarge,
      status: 413,
    });
    return;
  }

  try {
    await input.bucket.delete(key);
  } catch {
    logWorkerFailure({
      level: 'warn',
      event: 'upload_commit_oversize_object_delete_failed',
      errorCode: ERROR_CODES.payloadTooLarge,
      status: 413,
    });
  }
}

/**
 * ready への UPDATE が 0 件だった理由を引き直して返す。
 *
 * 行が消えていれば 404（pending の掃除が勝った）、既に ready なら並行 commit が
 * 先に確定しただけなので同じ応答で成功する（services/movies.ts の pin と同じ形）。
 * 稀な経路なので、通常時に追加のクエリを増やさないようここでだけ読み直す。
 */
async function resolveCommitConflict(input: CommitUploadInput): Promise<CommitResponse> {
  const current = await input.database
    .prepare(
      'SELECT short_id, user_id, size_bytes, status, expires_at FROM movies WHERE short_id = ? AND user_id = ?'
    )
    .bind(input.shortId, input.userId)
    .first<MovieRow>();

  if (!current) {
    throw new UploadError(404, ERROR_CODES.notFound, '対象の動画が見つかりません');
  }
  if (current.status === 'ready') return toCommitResponse(current, input.publicBaseUrl);
  throw new UploadError(400, ERROR_CODES.invalidRequest, 'この動画は commit できません');
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
