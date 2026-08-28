/**
 * 動画メタデータ（D1 movies）に対する参照・pin・削除。
 *
 * 履歴とプレビューページ（/{shortId}/）の両方がここを通る。SQL とビジネス規則を
 * 1 箇所に閉じ込め、エントリポイント（pages/）は HTTP との I/O 変換だけを担う。
 */

import {
  ERROR_CODES,
  type ErrorCode,
  type HistoryEntry,
  type HistoryResponse,
  type MovieStatus,
  type PinResponse,
  type RenameMovieResponse,
} from '../contracts/api';
import { isShortId, movieKey } from '../contracts/r2key';
import {
  MAX_PINNED_MOVIES,
  MOVIE_RETENTION_MS,
  PINNED_RETENTION_MS,
  UNPIN_GRACE_MS,
} from './quota';

/** 履歴に返す最大件数。ドロップダウンで一覧できる範囲に抑える。 */
export const HISTORY_LIMIT = 50;

/** プレビューページが描画に使う、公開済み（ready）の 1 件。 */
export interface PublicMovie {
  shortId: string;
  filename: string;
  publicUrl: string;
  pinned: boolean;
  createdAt: string;
  expiresAt: string | null;
  /** 所有者判定にだけ使うサーバー内部の値。レスポンスに含めないこと。 */
  ownerId: number;
}

/** D1 の最小操作面。サービスを workerd の実装から切り離す。 */
export interface MoviesDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}

/** R2 の削除に必要な最小操作面。 */
export interface MovieBucket {
  delete(key: string): Promise<void>;
}

/** エントリポイントが HTTP 応答へ変換するドメインエラー。 */
export class MovieActionError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 410,
    public readonly errorCode: ErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'MovieActionError';
  }
}

interface MovieRow {
  short_id: string;
  user_id: number;
  filename: string;
  status: MovieStatus;
  pinned: number;
  created_at: string;
  expires_at: string | null;
}

interface CountRow {
  total: number | null;
}

export interface ListHistoryInput {
  database: MoviesDatabase;
  userId: number;
  publicBaseUrl: string;
}

export interface MovieActionInput {
  database: MoviesDatabase;
  userId: number;
  shortId: string;
}

/**
 * 自分の movies を新しい順に返す。
 *
 * ready だけを返すのは、履歴を「共有できる動画の一覧」に揃えるため。pending は
 * presign から commit までの数秒しか続かない一方、アップロードが失敗すると誰も
 * failed へ落とさないまま残り、cron が回収する 24 時間後まで「処理中」と表示され
 * 続けていた（進捗は変換パネル側が持っているので履歴に出す必要がない）。
 */
export async function listHistory(input: ListHistoryInput): Promise<HistoryResponse> {
  // created_at は秒精度なので、同一秒の挿入で並びが揺れないよう short_id を第 2 キーにする。
  const { results } = await input.database
    .prepare(
      `SELECT short_id, user_id, filename, status, pinned, created_at, expires_at
       FROM movies
       WHERE user_id = ? AND status = 'ready'
       ORDER BY created_at DESC, short_id DESC
       LIMIT ?`
    )
    .bind(input.userId, HISTORY_LIMIT)
    .all<MovieRow>();

  return { movies: results.map((row) => toHistoryEntry(row, input.publicBaseUrl)) };
}

/**
 * pin を切り替える。
 *
 * pin 時は expires_at を今から 365 日後へ延ばし、解除時は元の保管期限
 * （created_at + 30 日）へ戻す。既に過ぎている場合は即時削除にならないよう猶予を与える。
 * pin し直すたびに 365 日後へ延びる（残したい動画は所有者が触り続ける前提）。
 *
 * 保管期限を過ぎた動画は 410 で断る。ここを通すと「期限切れ」が終端の状態でなくなり、
 * 保持期間バッチが R2 の実体を消してから D1 の行を消すまでの間に期限が延びて、
 * 実体だけが消えた行が残る（services/retention.ts の deleteExpiredMovies）。
 * 期限切れの動画は毎時のバッチでどのみち消えるので、延命の余地を残さない。
 *
 * 判定は 2 段構え。読んだ値での事前判定は理由（410）を上限超過（409）より先に返すためで、
 * 競合を防ぐのは UPDATE の WHERE に入れた期限条件の方。読んでから書くまでの間に期限が
 * 過ぎる可能性があるので、事前判定だけでは同じ競合が残る。
 */
export async function togglePin(
  input: MovieActionInput & { now?: Date }
): Promise<PinResponse> {
  const movie = await findOwnedMovie(input.database, input.userId, input.shortId);
  const now = input.now ?? new Date();

  if (isExpired(movie.expires_at, now)) {
    throw new MovieActionError(
      410,
      ERROR_CODES.expired,
      '保管期限を過ぎた動画は変更できません'
    );
  }

  const nextPinned = movie.pinned === 0;

  if (nextPinned) {
    const pinnedCount = await countPinnedMovies(input.database, input.userId);
    if (pinnedCount >= MAX_PINNED_MOVIES) {
      throw new MovieActionError(
        409,
        ERROR_CODES.invalidRequest,
        `ピン留めできるのは ${MAX_PINNED_MOVIES} 件までです`
      );
    }
  }

  const expiresAt = nextPinned
    ? new Date(now.getTime() + PINNED_RETENTION_MS).toISOString()
    : restoredExpiry(movie.created_at, now);

  // 比較は保持期間バッチと同じ datetime() で行う（ISO8601 と SQLite の表記が混在し、
  // 素の文字列比較では大小が逆転するため。精度と演算子も揃えて判定を食い違わせない）。
  const result = await input.database
    .prepare(
      'UPDATE movies SET pinned = ?, expires_at = ? WHERE short_id = ? AND user_id = ?' +
        ' AND (expires_at IS NULL OR datetime(expires_at) >= datetime(?))'
    )
    .bind(nextPinned ? 1 : 0, expiresAt, input.shortId, input.userId, now.toISOString())
    .run();

  // 0 件 = 読んだ後に期限が過ぎたか、行そのものが消えた。成功として返すと
  // 画面には pin 済みと出るのに実体は消える。
  if (result.meta.changes === 0) await throwPinConflict(input);

  return { shortId: input.shortId, pinned: nextPinned, expiresAt };
}

/**
 * pin の UPDATE が 0 件だった理由を引き直して投げる。
 *
 * 行が消えていれば 404（他の経路の削除・保持期間バッチと競合）、残っていれば 410（期限切れ）。
 * 稀な経路なので、通常時に追加のクエリを増やさないようここでだけ読み直す。
 */
async function throwPinConflict(input: MovieActionInput): Promise<never> {
  // 行が消えていればここで 404 になる。残っているなら、WHERE で外れた条件は期限しかない。
  await findOwnedMovie(input.database, input.userId, input.shortId);
  throw new MovieActionError(410, ERROR_CODES.expired, '保管期限を過ぎた動画は変更できません');
}

/**
 * 所有者の動画の表示名を変更する。
 *
 * filename は検証済み（validateRenameMovieRequest 通過後）の値を受け取る前提。
 * 形式の正本は contracts/api.ts なので、ここでは所有者チェックだけを行う。
 */
export async function renameMovie(
  input: MovieActionInput & { filename: string }
): Promise<RenameMovieResponse> {
  await findOwnedMovie(input.database, input.userId, input.shortId);
  await input.database
    .prepare('UPDATE movies SET filename = ? WHERE short_id = ? AND user_id = ?')
    .bind(input.filename, input.shortId, input.userId)
    .run();

  return { shortId: input.shortId, filename: input.filename };
}

/**
 * R2 の実体を消してから D1 の行を消す。
 *
 * 逆順にすると、R2 の削除に失敗したときに参照する行が消えて実体が孤立する
 * （所有者が二度と消せない残骸になる）。
 */
export async function deleteMovie(
  input: MovieActionInput & { bucket: MovieBucket }
): Promise<void> {
  await findOwnedMovie(input.database, input.userId, input.shortId);

  await input.bucket.delete(movieKey(input.shortId));
  await input.database
    .prepare('DELETE FROM movies WHERE short_id = ? AND user_id = ?')
    .bind(input.shortId, input.userId)
    .run();
}

/**
 * 公開プレビュー用に ready の 1 件を引く。認証しないので status で絞る
 * （pending / failed は URL を知っていても見えない）。
 */
export async function findPublicMovie(input: {
  database: MoviesDatabase;
  shortId: string;
  publicBaseUrl: string;
}): Promise<PublicMovie | null> {
  if (!isShortId(input.shortId)) return null;

  const row = await input.database
    .prepare(
      `SELECT short_id, user_id, filename, status, pinned, created_at, expires_at
       FROM movies
       WHERE short_id = ? AND status = 'ready'`
    )
    .bind(input.shortId)
    .first<MovieRow>();

  if (!row) return null;

  return {
    shortId: row.short_id,
    filename: row.filename,
    publicUrl: publicUrl(input.publicBaseUrl, row.short_id),
    pinned: row.pinned !== 0,
    createdAt: toIsoString(row.created_at),
    expiresAt: row.expires_at === null ? null : toIsoString(row.expires_at),
    ownerId: row.user_id,
  };
}

/** 所有者の行を引く。形式不正・不在・他人の shortId はすべて 404（存在を漏らさない）。 */
async function findOwnedMovie(
  database: MoviesDatabase,
  userId: number,
  shortId: string
): Promise<MovieRow> {
  if (!isShortId(shortId)) {
    throw new MovieActionError(404, ERROR_CODES.notFound, '対象の動画が見つかりません');
  }

  const row = await database
    .prepare(
      `SELECT short_id, user_id, filename, status, pinned, created_at, expires_at
       FROM movies
       WHERE short_id = ? AND user_id = ?`
    )
    .bind(shortId, userId)
    .first<MovieRow>();

  if (!row) {
    throw new MovieActionError(404, ERROR_CODES.notFound, '対象の動画が見つかりません');
  }
  return row;
}

async function countPinnedMovies(database: MoviesDatabase, userId: number): Promise<number> {
  const row = await database
    .prepare('SELECT COUNT(*) AS total FROM movies WHERE user_id = ? AND pinned = 1')
    .bind(userId)
    .first<CountRow>();

  return row?.total ?? 0;
}

/** pin 解除時の期限。元の期限が既に過ぎていたら、その場で消えないよう猶予を足す。 */
/**
 * 保管期限を過ぎているか。表記が ISO8601 と SQLite の datetime('now') で混在するため
 * toIsoString で揃えてから比較する（保持期間バッチの datetime() 比較と同じ理由）。
 */
function isExpired(expiresAt: string | null, now: Date): boolean {
  if (expiresAt === null) return false;
  const timestamp = Date.parse(toIsoString(expiresAt));
  return Number.isFinite(timestamp) && timestamp <= now.getTime();
}

function restoredExpiry(createdAt: string, now: Date): string {
  const restored = new Date(new Date(toIsoString(createdAt)).getTime() + MOVIE_RETENTION_MS);
  if (restored.getTime() > now.getTime()) return restored.toISOString();
  return new Date(now.getTime() + UNPIN_GRACE_MS).toISOString();
}

function toHistoryEntry(row: MovieRow, publicBaseUrl: string): HistoryEntry {
  return {
    shortId: row.short_id,
    filename: row.filename,
    status: row.status,
    pinned: row.pinned !== 0,
    createdAt: toIsoString(row.created_at),
    expiresAt: row.expires_at === null ? null : toIsoString(row.expires_at),
    publicUrl: publicUrl(publicBaseUrl, row.short_id),
  };
}

function publicUrl(publicBaseUrl: string, shortId: string): string {
  return new URL(movieKey(shortId), `${publicBaseUrl}/`).toString();
}

const SQLITE_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * D1 の日時を ISO8601（UTC）に揃える。
 *
 * created_at の DEFAULT は datetime('now') で "YYYY-MM-DD HH:MM:SS"（UTC）を返すが、
 * この文字列を Date に渡すと実行環境のローカル時刻として解釈され、workerd（UTC）と
 * 開発機（JST）で結果が 9 時間ずれる。境界でタイムゾーンを明示して揃える。
 */
function toIsoString(value: string): string {
  const normalized = SQLITE_DATETIME_PATTERN.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('movies の日時カラムを解釈できません');
  }
  return parsed.toISOString();
}
