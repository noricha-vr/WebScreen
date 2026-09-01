import { describe, expect, it } from 'bun:test';

import {
  MAX_UPLOAD_BYTES,
} from '../../src/lib/contracts/api';
import {
  getUserStorageUsage,
} from '../../src/lib/services/quota';
import {
  abandonUpload,
  commitUpload,
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
      const [userId] = values as [number];
      const statuses = parseUsageStatuses(query);
      const total = [...this.movies.values()]
        .filter((movie) => movie.userId === userId && statuses.has(movie.status))
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
    if (query.includes("status = 'ready'")) {
      const [sizeBytes, shortId, userId] = values as [number, string, number];
      const movie = this.movies.get(shortId);
      if (!movie || movie.userId !== userId || movie.status !== 'pending') return 0;
      movie.status = 'ready';
      movie.sizeBytes = sizeBytes;
      return 1;
    }

    if (query.includes("status = 'failed'")) {
      const updatesSize = query.includes("size_bytes = ?");
      const [sizeBytes, shortId, userId] = updatesSize
        ? (values as [number, string, number])
        : ([undefined, ...values] as [undefined, string, number]);
      const movie = this.movies.get(shortId);
      if (!movie || movie.userId !== userId || movie.status !== 'pending') return 0;
      movie.status = 'failed';
      if (sizeBytes !== undefined) movie.sizeBytes = sizeBytes;
      return 1;
    }

    return 0;
  }
}

function parseUsageStatuses(query: string): Set<MovieStatus> {
  const clause = query.match(/status\s+IN\s*\(([^)]+)\)/i)?.[1];
  if (!clause) throw new Error(`quota query must filter statuses: ${query}`);
  return new Set([...clause.matchAll(/'([^']+)'/g)].map((match) => match[1] as MovieStatus));
}

class FakeUploadBucket implements UploadBucket {
  deletedKeys: string[] = [];
  /** delete を失敗させる（R2 障害の再現）。 */
  failDelete = false;
  /** head の直後に走らせるフック（保持期間バッチの割り込みを再現する）。 */
  onHead: (() => void) | undefined;

  constructor(private readonly objectSize: number | null) {}

  async head(): Promise<{ size: number } | null> {
    this.onHead?.();
    return this.objectSize === null ? null : { size: this.objectSize };
  }

  async delete(key: string): Promise<void> {
    if (this.failDelete) throw new Error('R2 unavailable');
    this.deletedKeys.push(key);
  }
}

/** logWorkerFailure が warn で出した event 名だけを集める。 */
async function captureWarnEvents(run: () => Promise<void>): Promise<string[]> {
  const original = console.warn;
  const events: string[] = [];
  console.warn = ((entry: string) => events.push(JSON.parse(entry).event)) as typeof console.warn;
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return events;
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

describe('abandonUpload', () => {
  it('所有者の pending だけを failed にし、予約サイズを保持する', async () => {
    const database = new FakeUploadDatabase([
      movie(),
      movie({ shortId: 'OtherUser001', userId: USER_ID + 1 }),
      movie({ shortId: 'readyMovie001', status: 'ready' }),
    ]);

    await abandonUpload({ database, userId: USER_ID, shortId: SHORT_ID });
    await abandonUpload({ database, userId: USER_ID, shortId: SHORT_ID });
    await abandonUpload({ database, userId: USER_ID, shortId: 'OtherUser001' });
    await abandonUpload({ database, userId: USER_ID, shortId: 'readyMovie001' });

    expect(database.movies.get(SHORT_ID)).toMatchObject({ status: 'failed', sizeBytes: 100 });
    expect(database.movies.get('OtherUser001')?.status).toBe('pending');
    expect(database.movies.get('readyMovie001')?.status).toBe('ready');
    expect(await getUserStorageUsage(database, USER_ID)).toBe(200);
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

  it('実測サイズ超過時は実体を残して failed にし、実測サイズを容量へ計上する', async () => {
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
    // 署名 URL はまだ有効なので、この時点で実体を消すと遅延した再 PUT が孤児になる。
    // failed 行を残し、保持期間バッチが R2 → D1 の順に回収する。
    expect(bucket.deletedKeys).toEqual([]);
    expect(database.movies.get(SHORT_ID)?.status).toBe('failed');
    expect(database.movies.get(SHORT_ID)?.sizeBytes).toBe(MAX_UPLOAD_BYTES + 1);
    expect(await getUserStorageUsage(database, USER_ID)).toBe(MAX_UPLOAD_BYTES + 1);
  });

  it('実測サイズが申告の2倍を超えても、掃除までは R2 を削除しない', async () => {
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
    expect(bucket.deletedKeys).toEqual([]);
    expect(database.movies.get(SHORT_ID)?.status).toBe('failed');
  });

  it('上限超過でも R2 操作をせず、failed の行だけを残す', async () => {
    const database = new FakeUploadDatabase([movie()]);
    const bucket = new FakeUploadBucket(MAX_UPLOAD_BYTES + 1);
    bucket.failDelete = true;

    await expect(
      commitUpload({
        database,
        bucket,
        userId: USER_ID,
        shortId: SHORT_ID,
        publicBaseUrl: PUBLIC_URL,
      })
    ).rejects.toMatchObject({ status: 413 });

    expect(bucket.deletedKeys).toEqual([]);
    expect(database.movies.get(SHORT_ID)?.status).toBe('failed');
  });

  it('上限超過の確保に負けて行が ready なら、R2 に触らず同じ応答で成功する', async () => {
    const database = new FakeUploadDatabase([movie()]);
    const bucket = new FakeUploadBucket(MAX_UPLOAD_BYTES + 1);
    // head の後に別の commit が ready を確定させた状況。実体を消すと再生できる動画が壊れる。
    bucket.onHead = () => {
      const target = database.movies.get(SHORT_ID);
      if (target) target.status = 'ready';
    };

    let response: unknown;
    const events = await captureWarnEvents(async () => {
      response = await commitUpload({
        database,
        bucket,
        userId: USER_ID,
        shortId: SHORT_ID,
        publicBaseUrl: PUBLIC_URL,
      });
    });

    // 確定済みの行に上限超過（413）を返さない。理由は最終状態から引き直す。
    expect(response).toMatchObject({ shortId: SHORT_ID });
    expect(events).toEqual(['upload_commit_oversize_claim_missed']);
    expect(bucket.deletedKeys).toEqual([]);
    expect(database.movies.get(SHORT_ID)?.status).toBe('ready');
  });

  it('上限超過の確保に負けて行が消えていたら 404 を返す', async () => {
    const database = new FakeUploadDatabase([movie()]);
    const bucket = new FakeUploadBucket(MAX_UPLOAD_BYTES + 1);
    // 保持期間バッチが行ごと回収した状況。
    bucket.onHead = () => database.movies.delete(SHORT_ID);

    const events = await captureWarnEvents(async () => {
      await expect(
        commitUpload({
          database,
          bucket,
          userId: USER_ID,
          shortId: SHORT_ID,
          publicBaseUrl: PUBLIC_URL,
        })
      ).rejects.toMatchObject({ status: 404 });
    });

    expect(events).toEqual(['upload_commit_oversize_claim_missed']);
    expect(bucket.deletedKeys).toEqual([]);
  });

  it('上限超過の確保に負けて行が failed なら 400 を返す', async () => {
    const database = new FakeUploadDatabase([movie()]);
    const bucket = new FakeUploadBucket(MAX_UPLOAD_BYTES + 1);
    // 保持期間バッチが pending → failed の確保に成功した状況。
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
    expect(bucket.deletedKeys).toEqual([]);
  });
});
