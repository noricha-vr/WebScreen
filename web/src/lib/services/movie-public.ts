import { isShortId, movieUrl } from '../contracts/r2key';
import { toMovieIsoString } from './movie-time';

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

interface PublicMovieRow {
  short_id: string;
  user_id: number;
  filename: string;
  pinned: number;
  created_at: string;
  expires_at: string | null;
}

interface PublicMovieDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
    };
  };
}

/** 公開プレビュー用に ready の 1 件だけを引く。 */
export async function findPublicMovie(input: {
  database: PublicMovieDatabase;
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
    .first<PublicMovieRow>();
  if (!row) return null;

  return {
    shortId: row.short_id,
    filename: row.filename,
    publicUrl: movieUrl(input.publicBaseUrl, row.short_id),
    pinned: row.pinned !== 0,
    createdAt: toMovieIsoString(row.created_at),
    expiresAt: row.expires_at === null ? null : toMovieIsoString(row.expires_at),
    ownerId: row.user_id,
  };
}
