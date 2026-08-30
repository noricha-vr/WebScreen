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
import { isShortId, movieKey, movieUrl } from '../contracts/r2key';
import { logWorkerFailure } from '../infra/worker-log';
import { purgeMovieCache, type CachePurgeSettings } from './cache-purge';
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

interface ExpiryRow {
  /** SQLite の真偽値。1 = 保管期限を過ぎている。 */
  expired: number;
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
 * 判定は 2 段構え。読んだ値での事前判定は理由（期限切れの 410）を上限超過（409）より先に
 * 返すためで、競合を防ぐのは UPDATE の WHERE に入れた期限と件数の条件の方（どちらも D1 が
 * 実行時に評価する）。事前判定だけでは、判定から書き込みまでの間に期限をまたぐ経路と、
 * 別のリクエストが最後の pin 枠を埋める経路が残る。
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
    if (pinnedCount >= MAX_PINNED_MOVIES) throw pinLimitExceeded();
  }

  const expiresAt = nextPinned
    ? new Date(now.getTime() + PINNED_RETENTION_MS).toISOString()
    : restoredExpiry(movie.created_at, now);

  // 期限の判定は D1 の実行時刻（datetime('now')）で行う。リクエスト開始時に読んだ
  // now を渡すと、件数の問い合わせなどを挟む間に期限をまたいでも更新が通ってしまう。
  // 比較を datetime() で行うのは保持期間バッチと同じ理由（ISO8601 と SQLite の表記が
  // 混在し、素の文字列比較では大小が逆転するため）。
  //
  // pin する時は件数の上限も同じ文で数える。事前に読んだ件数で判定すると、数えてから
  // 書き込むまでの間に別のリクエストが枠を埋めても通り、上限を超えて 1 年間保管できる。
  // 解除する側は枠を空ける操作なので条件を足さない（上限に達していても解除はできる）。
  const pinLimitClause = nextPinned
    ? ' AND (SELECT COUNT(*) FROM movies AS pinned_movies' +
      ' WHERE pinned_movies.user_id = ? AND pinned_movies.pinned = 1) < ?'
    : '';
  const pinLimitBindings = nextPinned ? [input.userId, MAX_PINNED_MOVIES] : [];

  const result = await input.database
    .prepare(
      'UPDATE movies SET pinned = ?, expires_at = ? WHERE short_id = ? AND user_id = ?' +
        " AND (expires_at IS NULL OR datetime(expires_at) >= datetime('now'))" +
        pinLimitClause
    )
    .bind(nextPinned ? 1 : 0, expiresAt, input.shortId, input.userId, ...pinLimitBindings)
    .run();

  // 0 件 = 読んだ後に期限が過ぎた・pin の枠が埋まった・行そのものが消えた、のいずれか。
  // 成功として返すと、画面には pin 済みと出るのに実体は消える（または上限を超える）。
  if (result.meta.changes === 0) await throwPinConflict({ ...input, nextPinned });

  return { shortId: input.shortId, pinned: nextPinned, expiresAt };
}

/**
 * pin の UPDATE が 0 件だった理由を引き直して投げる。
 *
 * 行が消えていれば 404（他の経路の削除・保持期間バッチと競合）、期限切れなら 410、
 * 期限内で pin しようとしていたなら 409（WHERE に残る条件は件数しかない）。
 *
 * 期限は D1 の時刻で判定し、件数は数え直さない。リクエスト開始時の now で判定すると、
 * 書き込みの直前に期限が過ぎた行を「期限内」と読んで 409 を返す。件数を数え直すと、
 * 弾かれた直後に別のリクエストが pin を解除しただけで 410 に化ける。どちらも呼び出し側
 * （ui/preview-actions.ts）が 409 と 410 で別の文言を出すため、そのまま誤案内になる。
 */
async function throwPinConflict(
  input: MovieActionInput & { nextPinned: boolean }
): Promise<never> {
  const expiry = await findExpiryState(input.database, input.userId, input.shortId);

  // 行が消えていた（他の経路の削除・保持期間バッチと競合）。
  if (expiry === null) {
    throw new MovieActionError(404, ERROR_CODES.notFound, '対象の動画が見つかりません');
  }

  // 期限切れは終端の状態なので、上限超過より先に理由として返す（事前判定と同じ順序）。
  if (expiry.expired !== 0) {
    throw new MovieActionError(410, ERROR_CODES.expired, '保管期限を過ぎた動画は変更できません');
  }

  if (input.nextPinned) throw pinLimitExceeded();

  // 解除側の WHERE は期限と所有者だけなので、ここへは到達しない想定。
  throw new MovieActionError(410, ERROR_CODES.expired, '保管期限を過ぎた動画は変更できません');
}

/**
 * 行の有無と、D1 の時刻での期限切れ判定だけを引く。
 *
 * 比較の向きは UPDATE の WHERE（datetime(expires_at) >= datetime('now')）の裏返し。
 * 同じ式で判定しないと、0 件の理由が期限だったのかどうかを取り違える。
 */
async function findExpiryState(
  database: MoviesDatabase,
  userId: number,
  shortId: string
): Promise<ExpiryRow | null> {
  return database
    .prepare(
      "SELECT (expires_at IS NOT NULL AND datetime(expires_at) < datetime('now')) AS expired" +
        ' FROM movies WHERE short_id = ? AND user_id = ?'
    )
    .bind(shortId, userId)
    .first<ExpiryRow>();
}

/** pin の上限に達したことを伝える 409。事前判定と UPDATE の 0 件判定の両方から投げる。 */
function pinLimitExceeded(): MovieActionError {
  return new MovieActionError(
    409,
    ERROR_CODES.invalidRequest,
    `ピン留めできるのは ${MAX_PINNED_MOVIES} 件までです`
  );
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
  input: MovieActionInput & { bucket: MovieBucket; cachePurge: CachePurgeSettings }
): Promise<void> {
  await findOwnedMovie(input.database, input.userId, input.shortId);

  // R2 → D1 の順にするのは、途中で失敗した時に残る side が検出可能な方だから。
  // D1 を先に消すと、残った実体は行から辿れず誰も気づけない（R2 の孤児になる）。
  // R2 を先に消せば、残るのは実体の無い ready 行で、保持期間バッチの監査
  // （services/retention-audit.ts）が拾える。自動では直せないので、その場でも
  // 気づける印としてログに残してから呼び出し元へ返す。
  await input.bucket.delete(movieKey(input.shortId));

  // 実体を消した直後に Edge のキャッシュも落とす。ここを飛ばすと最大 120 分は
  // 削除済みの動画が配信され続ける（docs/r2-delivery.md）。D1 の行を消す前に呼ぶのは、
  // 行の削除が失敗して実体だけ消えた場合でもキャッシュを残さないため。purge は例外を
  // 投げない契約なので、失敗しても削除は 204 で完了する（120 分で自然に切れる）。
  await purgeMovieCache([input.shortId], input.cachePurge);

  try {
    await input.database
      .prepare('DELETE FROM movies WHERE short_id = ? AND user_id = ?')
      .bind(input.shortId, input.userId)
      .run();
  } catch (error) {
    logWorkerFailure({
      event: 'movie_delete_row_stranded',
      errorCode: ERROR_CODES.internalError,
      status: 500,
    });
    throw error;
  }
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
    publicUrl: movieUrl(input.publicBaseUrl, row.short_id),
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
    publicUrl: movieUrl(publicBaseUrl, row.short_id),
  };
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
