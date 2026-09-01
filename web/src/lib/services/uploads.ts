import {
  ERROR_CODES,
  MAX_UPLOAD_BYTES,
  type CommitResponse,
  type ErrorCode,
  type PresignRequest,
  type PresignResponse,
} from '../contracts/api';
import { generateShortId, movieKey, movieUrl } from '../contracts/r2key';
import { createR2PutPresignedUrl, type R2PresignConfig } from '../infra/r2presign';
import { logWorkerFailure } from '../infra/worker-log';
import {
  getUserUploadQuota,
  MAX_PENDING_UPLOADS_PER_USER,
  MOVIE_RETENTION_MS,
  USER_STORAGE_QUOTA_BYTES,
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
}

/** R2 URL 発行をテストから差し替えるための境界。 */
export type UploadUrlGenerator = (key: string) => Promise<string>;

/** API ハンドラが HTTP 応答へ変換するドメインエラー。 */
export class UploadError extends Error {
  constructor(
    public readonly status: 400 | 404 | 413 | 429,
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
  const key = movieKey(shortId);

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

  const exceedsPerFileLimit = object.size > MAX_UPLOAD_BYTES;
  const exceedsDeclaredSizeLimit = object.size > movie.size_bytes * 2;
  if (exceedsPerFileLimit || exceedsDeclaredSizeLimit) {
    // 確保に負けた行は、この呼び出しが上限超過として扱ってよい対象ではない。
    // 413 を返し続けると既に ready の行へ誤った理由を返すため、最終状態から引き直す。
    if (!(await claimOversizedUpload(input, object.size))) return resolveCommitConflict(input);
    throw new UploadError(
      413,
      ERROR_CODES.payloadTooLarge,
      'アップロード済み動画が保存上限を超えています'
    );
  }

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
      object.size,
      input.shortId,
      input.userId,
      input.userId,
      input.shortId,
      object.size,
      USER_STORAGE_QUOTA_BYTES
    )
    .run();

  // 0 件 = SELECT と R2 確認の間に行が pending でなくなった。成功として返すと、
  // 保持期間バッチが回収した動画の公開 URL を返してしまう（行も実体も無いのに再生できる想定になる）。
  if (updated.meta.changes === 0) {
    const current = await findMovie(input.database, input.userId, input.shortId);
    if (current?.status === 'pending') {
      if (await claimOversizedUpload(input, object.size)) {
        throw new UploadError(
          413,
          ERROR_CODES.payloadTooLarge,
          'アップロード済み動画が保存上限を超えています'
        );
      }
    }
    return resolveCommitConflict(input);
  }

  return toCommitResponse({ ...movie, size_bytes: object.size, status: 'ready' }, input.publicBaseUrl);
}

/**
 * 上限を超えた動画の予約を failed へ確保する。確保できたら true を返す。
 *
 * 署名 URL は発行から 5 分間有効なので、413 の直後に R2 を消すと遅延した PUT が
 * 孤児になる。実測サイズと failed 行を残し、署名失効後の保持期間バッチが R2 → D1 の
 * 順に回収する。確保に負けた（0 件）行には一切触れない。
 */
async function claimOversizedUpload(input: CommitUploadInput, actualSize: number): Promise<boolean> {
  const claim = await input.database
    .prepare(
      "UPDATE movies SET status = 'failed', size_bytes = ? WHERE short_id = ? AND user_id = ? AND status = 'pending'"
    )
    .bind(actualSize, input.shortId, input.userId)
    .run();

  if (claim.meta.changes === 0) {
    logWorkerFailure({
      level: 'warn',
      event: 'upload_commit_oversize_claim_missed',
      errorCode: ERROR_CODES.payloadTooLarge,
      status: 413,
    });
    return false;
  }

  return true;
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

/**
 * ready への UPDATE が 0 件だった理由を引き直して返す。
 *
 * 行が消えていれば 404（pending の掃除が勝った）、既に ready なら並行 commit が
 * 先に確定しただけなので同じ応答で成功する（services/movies.ts の pin と同じ形）。
 * 稀な経路なので、通常時に追加のクエリを増やさないようここでだけ読み直す。
 */
async function resolveCommitConflict(input: CommitUploadInput): Promise<CommitResponse> {
  const current = await findMovie(input.database, input.userId, input.shortId);

  if (!current) {
    throw new UploadError(404, ERROR_CODES.notFound, '対象の動画が見つかりません');
  }
  if (current.status === 'ready') return toCommitResponse(current, input.publicBaseUrl);
  throw new UploadError(400, ERROR_CODES.invalidRequest, 'この動画は commit できません');
}

/** shortId と所有者で movie を読み出す。並行更新後の状態解決に使う。 */
async function findMovie(
  database: UploadDatabase,
  userId: number,
  shortId: string
): Promise<MovieRow | null> {
  return database
    .prepare(
      'SELECT short_id, user_id, size_bytes, status, expires_at FROM movies WHERE short_id = ? AND user_id = ?'
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
