import { describe, expect, it } from 'bun:test';

import {
  MAX_UPLOAD_BYTES,
  validateAbandonUploadRequest,
  validatePresignRequest,
  type PresignRequest,
} from '../../src/lib/contracts/api';
import {
  USER_STORAGE_QUOTA_BYTES,
  getUserStorageUsage,
} from '../../src/lib/services/quota';
import { createPendingUpload, type UploadDatabase } from '../../src/lib/services/uploads';

type MovieStatus = 'pending' | 'ready' | 'failed';

interface TestMovie {
  shortId: string;
  userId: number;
  filename: string;
  sizeBytes: number;
  status: MovieStatus;
  expiresAt: string | null;
}

class FakeQuotaDatabase implements UploadDatabase {
  readonly movies = new Map<string, TestMovie>();

  constructor(movies: TestMovie[] = []) {
    for (const movie of movies) this.movies.set(movie.shortId, { ...movie });
  }

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        first: async <T>(): Promise<T | null> => this.first<T>(query, values),
        run: async () => ({ meta: { changes: this.run(query, values) } }),
      }),
    };
  }

  private first<T>(query: string, values: unknown[]): T | null {
    if (!query.startsWith('SELECT COALESCE')) return null;
    const userId = values[0] as number;
    const total = [...this.movies.values()]
      .filter(
        (movie) =>
          movie.userId === userId && ['pending', 'ready', 'failed'].includes(movie.status)
      )
      .reduce((sum, movie) => sum + movie.sizeBytes, 0);
    return { total } as T;
  }

  private run(query: string, values: unknown[]): number {
    if (!query.startsWith('INSERT INTO movies')) return 0;
    const [shortId, userId, filename, sizeBytes, expiresAt] = values as [
      string,
      number,
      string,
      number,
      string,
    ];
    if (query.includes('SELECT SUM(size_bytes)')) {
      const quotaUserId = values[5] as number;
      const additionalBytes = values[6] as number;
      const quotaBytes = values[7] as number;
      const usedBytes = [...this.movies.values()]
        .filter(
          (movie) =>
            movie.userId === quotaUserId && ['pending', 'ready', 'failed'].includes(movie.status)
        )
        .reduce((sum, movie) => sum + movie.sizeBytes, 0);
      if (usedBytes + additionalBytes > quotaBytes) return 0;
    }
    this.movies.set(shortId, {
      shortId,
      userId,
      filename,
      sizeBytes,
      status: 'pending',
      expiresAt,
    });
    return 1;
  }
}

const USER_ID = 10;
const SHORT_ID = 'AbCdEf123456';
const PUBLIC_URL = 'https://public.example';

function movie(overrides: Partial<TestMovie> = {}): TestMovie {
  return {
    shortId: SHORT_ID,
    userId: USER_ID,
    filename: 'movie.mp4',
    sizeBytes: 100,
    status: 'pending',
    expiresAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  };
}

function validPresignRequest(sizeBytes = 100): PresignRequest {
  return { filename: 'movie.mp4', sizeBytes, kind: 'pdf' };
}

describe('アップロードのクォータと検証', () => {
  it('500 MiB ちょうどまで、pending 分を含めて予約できる', async () => {
    const database = new FakeQuotaDatabase([
      movie({ sizeBytes: USER_STORAGE_QUOTA_BYTES - 100 }),
    ]);

    await expect(
      createPendingUpload({
        database,
        userId: USER_ID,
        request: validPresignRequest(100),
        publicBaseUrl: PUBLIC_URL,
        createUploadUrl: async () => 'https://upload.example',
        generateId: () => 'ZyXwVu987654',
      })
    ).resolves.toMatchObject({ shortId: 'ZyXwVu987654' });

    expect(await getUserStorageUsage(database, USER_ID)).toBe(USER_STORAGE_QUOTA_BYTES);
  });

  it('500 MiB を超える予約を 413 で拒否する', async () => {
    const database = new FakeQuotaDatabase([
      movie({ sizeBytes: USER_STORAGE_QUOTA_BYTES }),
    ]);

    await expect(
      createPendingUpload({
        database,
        userId: USER_ID,
        request: validPresignRequest(1),
        publicBaseUrl: PUBLIC_URL,
        createUploadUrl: async () => 'https://upload.example',
      })
    ).rejects.toMatchObject({ status: 413 });
  });

  it('残り 1 件分の容量へ 2 件を並行予約しても片方だけを確保する', async () => {
    const database = new FakeQuotaDatabase([
      movie({ sizeBytes: USER_STORAGE_QUOTA_BYTES - 100, status: 'ready' }),
    ]);
    let signed = 0;
    let releaseSignatures: (() => void) | undefined;
    const bothSigned = new Promise<void>((resolve) => {
      releaseSignatures = resolve;
    });
    const createUploadUrl = async (): Promise<string> => {
      signed += 1;
      if (signed === 2) releaseSignatures?.();
      await bothSigned;
      return 'https://upload.example';
    };

    const results = await Promise.allSettled(
      ['Concurrent01', 'Concurrent02'].map((shortId) =>
        createPendingUpload({
          database,
          userId: USER_ID,
          request: validPresignRequest(100),
          publicBaseUrl: PUBLIC_URL,
          createUploadUrl,
          generateId: () => shortId,
        })
      )
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 413 });
    expect(await getUserStorageUsage(database, USER_ID)).toBe(USER_STORAGE_QUOTA_BYTES);
  });

  it('署名 URL の発行に失敗したら pending 行を残さない', async () => {
    const database = new FakeQuotaDatabase();

    await expect(
      createPendingUpload({
        database,
        userId: USER_ID,
        request: validPresignRequest(100),
        publicBaseUrl: PUBLIC_URL,
        createUploadUrl: async () => {
          throw new Error('signing failed');
        },
      })
    ).rejects.toThrow('signing failed');

    expect(database.movies.size).toBe(0);
    expect(await getUserStorageUsage(database, USER_ID)).toBe(0);
  });

  it('51 MiB と未定義の kind を presign 前に拒否する', () => {
    expect(validatePresignRequest({ ...validPresignRequest(MAX_UPLOAD_BYTES + 1) }).ok).toBe(false);
    expect(validatePresignRequest({ ...validPresignRequest(), kind: 'audio' }).ok).toBe(false);
  });

  it('failed を含め、短い ID の abandon リクエストは拒否する', () => {
    expect(validateAbandonUploadRequest({ shortId: SHORT_ID }).ok).toBe(true);
    expect(validateAbandonUploadRequest({ shortId: 'short' }).ok).toBe(false);
  });
});
