import { describe, expect, it } from 'bun:test';

import {
  MAX_UPLOAD_BYTES,
  validatePresignRequest,
  type PresignRequest,
} from '../../src/lib/contracts/api';
import {
  USER_STORAGE_QUOTA_BYTES,
  getUserStorageUsage,
} from '../../src/lib/services/quota';
import {
  commitUpload,
  createPendingUpload,
  type UploadBucket,
  type UploadDatabase,
} from '../../src/lib/services/uploads';

type MovieStatus = 'pending' | 'ready' | 'failed';

interface TestMovie {
  shortId: string;
  userId: number;
  filename: string;
  sizeBytes: number;
  status: MovieStatus;
  expiresAt: string | null;
}

class FakeUploadDatabase implements UploadDatabase {
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
    if (query.startsWith('SELECT COALESCE')) {
      const userId = values[0] as number;
      const total = [...this.movies.values()]
        .filter((movie) => movie.userId === userId && (movie.status === 'pending' || movie.status === 'ready'))
        .reduce((sum, movie) => sum + movie.sizeBytes, 0);
      return { total } as T;
    }

    const [shortId, userId] = values as [string, number];
    const movie = this.movies.get(shortId);
    if (!movie || movie.userId !== userId) return null;
    return {
      short_id: movie.shortId,
      user_id: movie.userId,
      size_bytes: movie.sizeBytes,
      status: movie.status,
      expires_at: movie.expiresAt,
    } as T;
  }

  private run(query: string, values: unknown[]): number {
    if (query.startsWith('INSERT INTO movies')) {
      const [shortId, userId, filename, sizeBytes, expiresAt] = values as [
        string,
        number,
        string,
        number,
        string,
      ];
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

    if (query.includes("status = 'ready'")) {
      const [sizeBytes, shortId, userId] = values as [number, string, number];
      const movie = this.movies.get(shortId);
      if (!movie || movie.userId !== userId || movie.status !== 'pending') return 0;
      movie.status = 'ready';
      movie.sizeBytes = sizeBytes;
      return 1;
    }

    if (query.includes("status = 'failed'")) {
      const [shortId, userId] = values as [string, number];
      const movie = this.movies.get(shortId);
      if (!movie || movie.userId !== userId || movie.status !== 'pending') return 0;
      movie.status = 'failed';
      return 1;
    }

    return 0;
  }
}

class FakeUploadBucket implements UploadBucket {
  deletedKeys: string[] = [];
  /** head の直後に走らせるフック（保持期間バッチの割り込みを再現する）。 */
  onHead: (() => void) | undefined;

  constructor(private readonly objectSize: number | null) {}

  async head(): Promise<{ size: number } | null> {
    this.onHead?.();
    return this.objectSize === null ? null : { size: this.objectSize };
  }

  async delete(key: string): Promise<void> {
    this.deletedKeys.push(key);
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
    const existingPending = movie({ sizeBytes: USER_STORAGE_QUOTA_BYTES - 100 });
    const database = new FakeUploadDatabase([existingPending]);

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
    const database = new FakeUploadDatabase([movie({ sizeBytes: USER_STORAGE_QUOTA_BYTES })]);

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

  it('51 MiB と未定義の kind を presign 前に拒否する', () => {
    expect(validatePresignRequest({ ...validPresignRequest(MAX_UPLOAD_BYTES + 1) }).ok).toBe(false);
    expect(validatePresignRequest({ ...validPresignRequest(), kind: 'audio' }).ok).toBe(false);
  });
});

describe('commitUpload', () => {
  it('pending を ready に遷移し、実測サイズを返す', async () => {
    const database = new FakeUploadDatabase([movie({ sizeBytes: 200 })]);

    await expect(
      commitUpload({
        database,
        bucket: new FakeUploadBucket(321),
        userId: USER_ID,
        shortId: SHORT_ID,
        publicBaseUrl: PUBLIC_URL,
      })
    ).resolves.toEqual({
      shortId: SHORT_ID,
      publicUrl: `https://public.example/movies/${SHORT_ID}.mp4`,
      sizeBytes: 321,
      expiresAt: '2026-09-24T00:00:00.000Z',
    });
    expect(database.movies.get(SHORT_ID)?.status).toBe('ready');
  });

  it('ready の二重 commit は同じ応答で成功する', async () => {
    const database = new FakeUploadDatabase([movie({ status: 'ready', sizeBytes: 321 })]);

    await expect(
      commitUpload({
        database,
        bucket: new FakeUploadBucket(null),
        userId: USER_ID,
        shortId: SHORT_ID,
        publicBaseUrl: PUBLIC_URL,
      })
    ).resolves.toMatchObject({ shortId: SHORT_ID, sizeBytes: 321 });
  });

  it('R2 確認中に保持期間バッチが行を回収したら 404 を返す', async () => {
    const database = new FakeUploadDatabase([movie({ sizeBytes: 200 })]);
    const bucket = new FakeUploadBucket(321);
    // pending の掃除が先に行を確保した状況（実体はこの後バッチが消す）。
    bucket.onHead = () => database.movies.delete(SHORT_ID);

    await expect(
      commitUpload({
        database,
        bucket,
        userId: USER_ID,
        shortId: SHORT_ID,
        publicBaseUrl: PUBLIC_URL,
      })
    ).rejects.toMatchObject({ status: 404 });
    expect(database.movies.size).toBe(0);
  });

  it('R2 確認中に保持期間バッチが行を failed で確保したら 400 を返す', async () => {
    const database = new FakeUploadDatabase([movie({ sizeBytes: 200 })]);
    const bucket = new FakeUploadBucket(321);
    // 掃除が pending → failed の確保に成功した状況（実体はこの後バッチが消す）。
    bucket.onHead = () => {
      const target = database.movies.get(SHORT_ID);
      if (target) target.status = 'failed';
    };

    await expect(
      commitUpload({
        database,
        bucket,
        userId: USER_ID,
        shortId: SHORT_ID,
        publicBaseUrl: PUBLIC_URL,
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(database.movies.get(SHORT_ID)?.status).toBe('failed');
  });

  it('R2 確認中に別の commit が確定していたら同じ応答で成功する', async () => {
    const database = new FakeUploadDatabase([movie({ sizeBytes: 200 })]);
    const bucket = new FakeUploadBucket(321);
    bucket.onHead = () => {
      const target = database.movies.get(SHORT_ID);
      if (target) {
        target.status = 'ready';
        target.sizeBytes = 321;
      }
    };

    await expect(
      commitUpload({
        database,
        bucket,
        userId: USER_ID,
        shortId: SHORT_ID,
        publicBaseUrl: PUBLIC_URL,
      })
    ).resolves.toMatchObject({ shortId: SHORT_ID, sizeBytes: 321 });
    expect(database.movies.get(SHORT_ID)?.status).toBe('ready');
  });

  it('他人の shortId は 404 を返す', async () => {
    const database = new FakeUploadDatabase([movie({ userId: USER_ID + 1 })]);

    await expect(
      commitUpload({
        database,
        bucket: new FakeUploadBucket(100),
        userId: USER_ID,
        shortId: SHORT_ID,
        publicBaseUrl: PUBLIC_URL,
      })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('実測サイズ超過時は R2 を削除して failed にする', async () => {
    const database = new FakeUploadDatabase([movie()]);
    const bucket = new FakeUploadBucket(MAX_UPLOAD_BYTES + 1);

    await expect(
      commitUpload({
        database,
        bucket,
        userId: USER_ID,
        shortId: SHORT_ID,
        publicBaseUrl: PUBLIC_URL,
      })
    ).rejects.toMatchObject({ status: 413 });
    expect(bucket.deletedKeys).toEqual([`movies/${SHORT_ID}.mp4`]);
    expect(database.movies.get(SHORT_ID)?.status).toBe('failed');
  });

  it('実測サイズが申告の2倍を超えると R2 を削除して failed にする', async () => {
    const database = new FakeUploadDatabase([movie({ sizeBytes: 100 })]);
    const bucket = new FakeUploadBucket(201);

    await expect(
      commitUpload({
        database,
        bucket,
        userId: USER_ID,
        shortId: SHORT_ID,
        publicBaseUrl: PUBLIC_URL,
      })
    ).rejects.toMatchObject({ status: 413 });
    expect(bucket.deletedKeys).toEqual([`movies/${SHORT_ID}.mp4`]);
    expect(database.movies.get(SHORT_ID)?.status).toBe('failed');
  });
});
