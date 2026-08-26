import { describe, expect, it } from 'bun:test';

import {
  MAX_PINNED_MOVIES,
  MOVIE_RETENTION_MS,
  UNPIN_GRACE_MS,
} from '../../src/lib/services/quota';
import {
  deleteMovie,
  findPublicMovie,
  listHistory,
  renameMovie,
  togglePin,
  type MovieBucket,
  type MoviesDatabase,
} from '../../src/lib/services/movies';

type MovieStatus = 'pending' | 'ready' | 'failed';

interface TestMovie {
  shortId: string;
  userId: number;
  filename: string;
  status: MovieStatus;
  pinned: number;
  /** D1 の DEFAULT datetime('now') と同じ "YYYY-MM-DD HH:MM:SS"（UTC）で持つ。 */
  createdAt: string;
  expiresAt: string | null;
}

/** D1 binding の代役。SQL の先頭句で分岐し、実際の movies テーブルの挙動だけを真似る。 */
class FakeMoviesDatabase implements MoviesDatabase {
  readonly movies = new Map<string, TestMovie>();

  constructor(movies: TestMovie[] = []) {
    for (const movie of movies) this.movies.set(movie.shortId, { ...movie });
  }

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        first: async <T>(): Promise<T | null> => this.first<T>(query, values),
        all: async <T>(): Promise<{ results: T[] }> => ({ results: this.all<T>(query, values) }),
        run: async (): Promise<unknown> => this.run(query, values),
      }),
    };
  }

  private first<T>(query: string, values: unknown[]): T | null {
    if (query.includes('COUNT(*)')) {
      const userId = values[0] as number;
      const total = [...this.movies.values()].filter(
        (movie) => movie.userId === userId && movie.pinned === 1
      ).length;
      return { total } as T;
    }

    if (query.includes("status = 'ready'")) {
      const shortId = values[0] as string;
      const movie = this.movies.get(shortId);
      return movie && movie.status === 'ready' ? (toRow(movie) as T) : null;
    }

    const [shortId, userId] = values as [string, number];
    const movie = this.movies.get(shortId);
    return movie && movie.userId === userId ? (toRow(movie) as T) : null;
  }

  private all<T>(_query: string, values: unknown[]): T[] {
    const [userId, limit] = values as [number, number];
    return [...this.movies.values()]
      .filter((movie) => movie.userId === userId && movie.status !== 'failed')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
      .map((movie) => toRow(movie) as T);
  }

  private run(query: string, values: unknown[]): void {
    if (query.startsWith('UPDATE movies SET filename')) {
      const [filename, shortId, userId] = values as [string, string, number];
      const movie = this.movies.get(shortId);
      if (movie && movie.userId === userId) movie.filename = filename;
      return;
    }

    if (query.startsWith('UPDATE movies SET pinned')) {
      const [pinned, expiresAt, shortId, userId] = values as [number, string | null, string, number];
      const movie = this.movies.get(shortId);
      if (movie && movie.userId === userId) {
        movie.pinned = pinned;
        movie.expiresAt = expiresAt;
      }
      return;
    }

    if (query.startsWith('DELETE FROM movies')) {
      const [shortId, userId] = values as [string, number];
      const movie = this.movies.get(shortId);
      if (movie && movie.userId === userId) this.movies.delete(shortId);
    }
  }
}

class FakeMovieBucket implements MovieBucket {
  readonly deletedKeys: string[] = [];

  async delete(key: string): Promise<void> {
    this.deletedKeys.push(key);
  }
}

function toRow(movie: TestMovie) {
  return {
    short_id: movie.shortId,
    user_id: movie.userId,
    filename: movie.filename,
    status: movie.status,
    pinned: movie.pinned,
    created_at: movie.createdAt,
    expires_at: movie.expiresAt,
  };
}

const USER_ID = 10;
const SHORT_ID = 'AbCdEf123456';
const PUBLIC_URL = 'https://public.example';
const CREATED_AT = '2026-08-01 00:00:00';

function movie(overrides: Partial<TestMovie> = {}): TestMovie {
  return {
    shortId: SHORT_ID,
    userId: USER_ID,
    filename: 'slides.pdf',
    status: 'ready',
    pinned: 0,
    createdAt: CREATED_AT,
    expiresAt: '2026-08-31T00:00:00.000Z',
    ...overrides,
  };
}

function pinnedMovies(count: number): TestMovie[] {
  return Array.from({ length: count }, (_unused, index) =>
    movie({ shortId: `pinned${String(index).padStart(6, '0')}`, pinned: 1, expiresAt: null })
  );
}

describe('listHistory', () => {
  it('自分の pending と ready を新しい順に返し、日時を ISO8601 へ揃える', async () => {
    const database = new FakeMoviesDatabase([
      movie({ shortId: 'old000000001', createdAt: '2026-08-01 00:00:00' }),
      movie({ shortId: 'new000000002', createdAt: '2026-08-20 09:30:00', status: 'pending' }),
    ]);

    const { movies } = await listHistory({ database, userId: USER_ID, publicBaseUrl: PUBLIC_URL });

    expect(movies.map((entry) => entry.shortId)).toEqual(['new000000002', 'old000000001']);
    expect(movies[0]).toMatchObject({
      status: 'pending',
      pinned: false,
      // "YYYY-MM-DD HH:MM:SS" は UTC。ローカル時刻として解釈すると実行環境でずれる
      createdAt: '2026-08-20T09:30:00.000Z',
      publicUrl: `${PUBLIC_URL}/movies/new000000002.mp4`,
    });
  });

  it('他人の動画は返さない', async () => {
    const database = new FakeMoviesDatabase([movie({ userId: USER_ID + 1 })]);

    const { movies } = await listHistory({ database, userId: USER_ID, publicBaseUrl: PUBLIC_URL });

    expect(movies).toEqual([]);
  });
});

describe('togglePin', () => {
  it('pin すると期限が無期限（null）になる', async () => {
    const database = new FakeMoviesDatabase([movie()]);

    await expect(togglePin({ database, userId: USER_ID, shortId: SHORT_ID })).resolves.toEqual({
      shortId: SHORT_ID,
      pinned: true,
      expiresAt: null,
    });
    expect(database.movies.get(SHORT_ID)).toMatchObject({ pinned: 1, expiresAt: null });
  });

  it('pin 解除で作成から 30 日後の期限に戻る', async () => {
    const database = new FakeMoviesDatabase([movie({ pinned: 1, expiresAt: null })]);
    const now = new Date('2026-08-10T00:00:00.000Z');

    const response = await togglePin({ database, userId: USER_ID, shortId: SHORT_ID, now });

    expect(response.pinned).toBe(false);
    expect(response.expiresAt).toBe(
      new Date(Date.parse('2026-08-01T00:00:00.000Z') + MOVIE_RETENTION_MS).toISOString()
    );
  });

  it('復元した期限が過去になる場合は現在から 7 日後に伸ばす', async () => {
    const database = new FakeMoviesDatabase([movie({ pinned: 1, expiresAt: null })]);
    const now = new Date('2026-12-01T00:00:00.000Z');

    const response = await togglePin({ database, userId: USER_ID, shortId: SHORT_ID, now });

    expect(response.expiresAt).toBe(new Date(now.getTime() + UNPIN_GRACE_MS).toISOString());
  });

  it('pin が 10 件に達していると 409 で拒否する', async () => {
    const database = new FakeMoviesDatabase([...pinnedMovies(MAX_PINNED_MOVIES), movie()]);

    await expect(
      togglePin({ database, userId: USER_ID, shortId: SHORT_ID })
    ).rejects.toMatchObject({ status: 409 });
    expect(database.movies.get(SHORT_ID)?.pinned).toBe(0);
  });

  it('9 件なら 10 件目を pin できる', async () => {
    const database = new FakeMoviesDatabase([...pinnedMovies(MAX_PINNED_MOVIES - 1), movie()]);

    await expect(
      togglePin({ database, userId: USER_ID, shortId: SHORT_ID })
    ).resolves.toMatchObject({ pinned: true });
  });

  it('上限に達していても pin 解除はできる', async () => {
    const database = new FakeMoviesDatabase(pinnedMovies(MAX_PINNED_MOVIES));

    await expect(
      togglePin({ database, userId: USER_ID, shortId: 'pinned000000' })
    ).resolves.toMatchObject({ pinned: false });
  });

  it('他人の動画は 404 で拒否する', async () => {
    const database = new FakeMoviesDatabase([movie({ userId: USER_ID + 1 })]);

    await expect(
      togglePin({ database, userId: USER_ID, shortId: SHORT_ID })
    ).rejects.toMatchObject({ status: 404 });
    expect(database.movies.get(SHORT_ID)?.pinned).toBe(0);
  });
});

describe('renameMovie', () => {
  it('所有者のファイル名を trim して変更する', async () => {
    const database = new FakeMoviesDatabase([movie()]);

    await expect(
      renameMovie({ database, userId: USER_ID, shortId: SHORT_ID, filename: ' renamed.mp4 ' })
    ).resolves.toEqual({ shortId: SHORT_ID, filename: 'renamed.mp4' });
    expect(database.movies.get(SHORT_ID)?.filename).toBe('renamed.mp4');
  });

  it.each([
    ['', '空文字'],
    ['   ', '空白のみ'],
    ['a'.repeat(256), '256 文字'],
    ['folder/file.mp4', 'パス区切り'],
  ])('%s（%s）は 400 で拒否する', async (filename) => {
    const database = new FakeMoviesDatabase([movie()]);

    await expect(
      renameMovie({ database, userId: USER_ID, shortId: SHORT_ID, filename })
    ).rejects.toMatchObject({ status: 400, errorCode: 'INVALID_REQUEST' });
    expect(database.movies.get(SHORT_ID)?.filename).toBe('slides.pdf');
  });

  it('他人の動画は 404 で拒否する', async () => {
    const database = new FakeMoviesDatabase([movie({ userId: USER_ID + 1 })]);

    await expect(
      renameMovie({ database, userId: USER_ID, shortId: SHORT_ID, filename: 'renamed.mp4' })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('不在の動画は 404 で拒否する', async () => {
    const database = new FakeMoviesDatabase();

    await expect(
      renameMovie({ database, userId: USER_ID, shortId: SHORT_ID, filename: 'renamed.mp4' })
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('deleteMovie', () => {
  it('R2 の実体を消してから D1 の行を消す', async () => {
    const database = new FakeMoviesDatabase([movie()]);
    const bucket = new FakeMovieBucket();

    await deleteMovie({ database, bucket, userId: USER_ID, shortId: SHORT_ID });

    expect(bucket.deletedKeys).toEqual([`movies/${SHORT_ID}.mp4`]);
    expect(database.movies.has(SHORT_ID)).toBe(false);
  });

  it('他人の動画は 404 で拒否し、R2 にも触らない', async () => {
    const database = new FakeMoviesDatabase([movie({ userId: USER_ID + 1 })]);
    const bucket = new FakeMovieBucket();

    await expect(
      deleteMovie({ database, bucket, userId: USER_ID, shortId: SHORT_ID })
    ).rejects.toMatchObject({ status: 404 });
    expect(bucket.deletedKeys).toEqual([]);
    expect(database.movies.has(SHORT_ID)).toBe(true);
  });

  it('shortId の形式が不正なら DB を引く前に 404 で止める', async () => {
    const database = new FakeMoviesDatabase([movie()]);
    const bucket = new FakeMovieBucket();

    await expect(
      deleteMovie({ database, bucket, userId: USER_ID, shortId: '../../etc/passwd' })
    ).rejects.toMatchObject({ status: 404 });
    expect(bucket.deletedKeys).toEqual([]);
  });
});

describe('findPublicMovie', () => {
  it('ready の動画を公開 URL 付きで返す', async () => {
    const database = new FakeMoviesDatabase([movie()]);

    await expect(
      findPublicMovie({ database, shortId: SHORT_ID, publicBaseUrl: PUBLIC_URL })
    ).resolves.toMatchObject({
      shortId: SHORT_ID,
      filename: 'slides.pdf',
      publicUrl: `${PUBLIC_URL}/movies/${SHORT_ID}.mp4`,
      pinned: false,
      ownerId: USER_ID,
    });
  });

  it('pending / failed は公開しない', async () => {
    for (const status of ['pending', 'failed'] as const) {
      const database = new FakeMoviesDatabase([movie({ status })]);

      await expect(
        findPublicMovie({ database, shortId: SHORT_ID, publicBaseUrl: PUBLIC_URL })
      ).resolves.toBeNull();
    }
  });

  it.each([
    ['ja', '短すぎる'],
    ['abcdefghijklm', '長すぎる'],
    ['AbCdEf-12345', '記号を含む'],
    ['../../etc/pw', 'パス区切りを含む'],
  ])('%s（%s）は DB を引かずに null', async (shortId) => {
    const database = new FakeMoviesDatabase([movie()]);

    await expect(
      findPublicMovie({ database, shortId: shortId as string, publicBaseUrl: PUBLIC_URL })
    ).resolves.toBeNull();
  });
});
