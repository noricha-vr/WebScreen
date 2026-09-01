import { describe, expect, it } from 'bun:test';

import {
  findPublicMovie,
  renameMovie,
  type MoviesDatabase,
} from '../../src/lib/services/movies';

type MovieStatus = 'pending' | 'ready' | 'failed';

interface TestMovie {
  shortId: string;
  userId: number;
  filename: string;
  status: MovieStatus;
}

class MetadataDatabase implements MoviesDatabase {
  readonly movies = new Map<string, TestMovie>();

  constructor(movies: TestMovie[] = []) {
    for (const movie of movies) this.movies.set(movie.shortId, { ...movie });
  }

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        first: async <T>(): Promise<T | null> => this.first<T>(query, values),
        all: async <T>(): Promise<{ results: T[] }> => ({ results: [] }),
        run: async (): Promise<{ meta: { changes: number } }> => this.run(query, values),
      }),
    };
  }

  private first<T>(query: string, values: unknown[]): T | null {
    const shortId = values[0] as string;
    const movie = this.movies.get(shortId);
    if (!movie) return null;
    if (query.includes("status = 'ready'")) {
      return movie.status === 'ready' ? (toRow(movie) as T) : null;
    }
    const userId = values[1] as number;
    return movie.userId === userId ? (toRow(movie) as T) : null;
  }

  private run(query: string, values: unknown[]): { meta: { changes: number } } {
    if (!query.startsWith('UPDATE movies SET filename')) return { meta: { changes: 0 } };
    const [filename, shortId, userId] = values as [string, string, number];
    const movie = this.movies.get(shortId);
    if (!movie || movie.userId !== userId) return { meta: { changes: 0 } };
    movie.filename = filename;
    return { meta: { changes: 1 } };
  }
}

const USER_ID = 10;
const SHORT_ID = 'AbCdEf123456';
const PUBLIC_URL = 'https://public.example';

function movie(overrides: Partial<TestMovie> = {}): TestMovie {
  return {
    shortId: SHORT_ID,
    userId: USER_ID,
    filename: 'slides.pdf',
    status: 'ready',
    ...overrides,
  };
}

function toRow(value: TestMovie) {
  return {
    short_id: value.shortId,
    user_id: value.userId,
    filename: value.filename,
    status: value.status,
    pinned: 0,
    created_at: '2026-08-01 00:00:00',
    expires_at: '2099-01-01T00:00:00.000Z',
  };
}

describe('renameMovie', () => {
  it('所有者のファイル名を変更する', async () => {
    const database = new MetadataDatabase([movie()]);

    await expect(
      renameMovie({ database, userId: USER_ID, shortId: SHORT_ID, filename: 'renamed.mp4' })
    ).resolves.toEqual({ shortId: SHORT_ID, filename: 'renamed.mp4' });
    expect(database.movies.get(SHORT_ID)?.filename).toBe('renamed.mp4');
  });

  it('他人と不在の動画は 404 で拒否する', async () => {
    const other = new MetadataDatabase([movie({ userId: USER_ID + 1 })]);
    const missing = new MetadataDatabase();

    await expect(
      renameMovie({ database: other, userId: USER_ID, shortId: SHORT_ID, filename: 'renamed.mp4' })
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      renameMovie({ database: missing, userId: USER_ID, shortId: SHORT_ID, filename: 'renamed.mp4' })
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('findPublicMovie', () => {
  it('ready の動画を公開 URL 付きで返す', async () => {
    const database = new MetadataDatabase([movie()]);

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
      const database = new MetadataDatabase([movie({ status })]);
      await expect(
        findPublicMovie({ database, shortId: SHORT_ID, publicBaseUrl: PUBLIC_URL })
      ).resolves.toBeNull();
    }
  });

  it.each(['ja', 'abcdefghijklm', 'AbCdEf-12345', '../../etc/pw'])(
    '%s は DB を引かずに null',
    async (shortId) => {
      const database = new MetadataDatabase([movie()]);
      await expect(findPublicMovie({ database, shortId, publicBaseUrl: PUBLIC_URL })).resolves.toBeNull();
    }
  );
});
