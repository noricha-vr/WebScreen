import { describe, expect, it } from 'bun:test';

import { captureKey, movieKey } from '../../src/lib/contracts/r2key';
import {
  CAPTURE_KEY_PREFIX,
  MAX_CAPTURE_DELETIONS_PER_RUN,
  runRetention,
  type RetentionBucket,
  type RetentionDatabase,
  type RetentionListResult,
  type RetentionObject,
} from '../../src/lib/services/retention';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type MovieStatus = 'pending' | 'ready' | 'failed';

interface TestMovie {
  shortId: string;
  status: MovieStatus;
  pinned: 0 | 1;
  createdAt: string;
  expiresAt: string | null;
}

/**
 * SQLite の datetime() 相当の正規化。D1 には ISO8601（expires_at）と
 * `YYYY-MM-DD HH:MM:SS`（created_at の既定値）が混在するため、フェイクでも
 * 同じように両方を UTC として解釈する。
 */
function parseSqliteTime(value: string): number {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  return Date.parse(/[Z+]|-\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
}

/** 掃除対象の条件（expires_at が設定済みで、かつ閾値より前）。 */
function isExpired(movie: TestMovie, threshold: number): boolean {
  return movie.expiresAt !== null && parseSqliteTime(movie.expiresAt) < threshold;
}

class FakeRetentionDatabase implements RetentionDatabase {
  readonly movies = new Map<string, TestMovie>();
  /** 行を SELECT した直後に走らせるフック（pin の割り込みを再現する）。 */
  onSelect: ((rows: TestMovie[]) => void) | undefined;

  constructor(movies: TestMovie[]) {
    for (const movie of movies) this.movies.set(movie.shortId, { ...movie });
  }

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        all: async <T>(): Promise<{ results: T[] }> => ({
          results: this.select(query, values) as T[],
        }),
        run: async (): Promise<{ meta: { changes: number } }> => ({
          meta: { changes: this.delete(query, values) },
        }),
      }),
    };
  }

  private select(query: string, values: unknown[]): { short_id: string }[] {
    // 削除直前の再確認（short_id と閾値の 2 引数）。pin ではなく期限で判定する。
    if (query.includes('WHERE short_id = ?')) {
      const movie = this.movies.get(values[0] as string);
      return movie && isExpired(movie, parseSqliteTime(values[1] as string))
        ? [{ short_id: movie.shortId }]
        : [];
    }

    const threshold = parseSqliteTime(values[0] as string);
    const rows = [...this.movies.values()].filter((movie) =>
      query.includes("status = 'ready'")
        ? movie.status === 'ready' && isExpired(movie, threshold)
        : movie.status === 'pending' && parseSqliteTime(movie.createdAt) < threshold
    );
    this.onSelect?.(rows);
    return rows.map((movie) => ({ short_id: movie.shortId }));
  }

  private delete(query: string, values: unknown[]): number {
    if (query.includes("status = 'failed'")) {
      const threshold = parseSqliteTime(values[0] as string);
      const targets = [...this.movies.values()].filter(
        (movie) => movie.status === 'failed' && parseSqliteTime(movie.createdAt) < threshold
      );
      for (const movie of targets) this.movies.delete(movie.shortId);
      return targets.length;
    }

    const movie = this.movies.get(values[0] as string);
    if (!movie) return 0;
    if (query.includes('expires_at') && !isExpired(movie, parseSqliteTime(values[1] as string))) {
      return 0;
    }
    if (query.includes("status = 'pending'") && movie.status !== 'pending') return 0;
    this.movies.delete(movie.shortId);
    return 1;
  }
}

class FakeRetentionBucket implements RetentionBucket {
  readonly deleted: string[] = [];
  readonly listCalls: (string | undefined)[] = [];
  /** delete が例外を投げるキー（R2 障害の再現）。 */
  failingKeys = new Set<string>();

  constructor(
    readonly objects = new Set<string>(),
    private readonly pages: RetentionListResult[] = [{ objects: [], truncated: false }]
  ) {}

  async head(key: string): Promise<{ size: number } | null> {
    return this.objects.has(key) ? { size: 1 } : null;
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      if (this.failingKeys.has(key)) throw new Error(`R2 delete failed: ${key}`);
    }
    this.deleted.push(...list);
  }

  async list(options: { prefix: string; cursor?: string }): Promise<RetentionListResult> {
    this.listCalls.push(options.cursor);
    const index = options.cursor === undefined ? 0 : Number(options.cursor);
    return this.pages[index] ?? { objects: [], truncated: false };
  }
}

function movie(overrides: Partial<TestMovie> & { shortId: string }): TestMovie {
  return {
    status: 'ready',
    pinned: 0,
    createdAt: new Date(NOW.getTime() - 40 * DAY_MS).toISOString(),
    expiresAt: null,
    ...overrides,
  };
}

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function captureObject(index: number, uploadedOffsetMs: number): RetentionObject {
  return {
    key: captureKey('11111111-2222-3333-4444-555555555555', index),
    uploaded: new Date(NOW.getTime() + uploadedOffsetMs),
  };
}

async function run(database: FakeRetentionDatabase, bucket: FakeRetentionBucket) {
  return runRetention({ database, bucket, now: NOW });
}

describe('runRetention: 期限切れ動画', () => {
  it('期限を過ぎた ready 動画を R2 と D1 の両方から消す', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'expiredAAAAA', expiresAt: iso(-HOUR_MS) }),
    ]);
    const bucket = new FakeRetentionBucket();

    const summary = await run(database, bucket);

    expect(summary.deletedMovies).toBe(1);
    expect(bucket.deleted).toEqual([movieKey('expiredAAAAA')]);
    expect(database.movies.has('expiredAAAAA')).toBe(false);
  });

  it('pin された動画も期限を過ぎていれば消す', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'pinnedAAAAAA', pinned: 1, expiresAt: iso(-DAY_MS) }),
    ]);
    const bucket = new FakeRetentionBucket();

    const summary = await run(database, bucket);

    expect(summary.deletedMovies).toBe(1);
    expect(bucket.deleted).toEqual([movieKey('pinnedAAAAAA')]);
    expect(database.movies.has('pinnedAAAAAA')).toBe(false);
  });

  it('期限内の pin された動画は残す', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'pinnedLiveAA', pinned: 1, expiresAt: iso(300 * DAY_MS) }),
    ]);
    const bucket = new FakeRetentionBucket();

    const summary = await run(database, bucket);

    expect(summary.deletedMovies).toBe(0);
    expect(bucket.deleted).toEqual([]);
    expect(database.movies.has('pinnedLiveAA')).toBe(true);
  });

  it('SELECT 後・R2 削除前に期限が延びた動画は R2 と D1 の両方を残す', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'racePinAAAAA', expiresAt: iso(-HOUR_MS) }),
    ]);
    const bucket = new FakeRetentionBucket();
    // SELECT 直後に所有者が pin した状況（期限が 1 年後へ延びる）。
    database.onSelect = (rows) => {
      for (const row of rows) {
        row.pinned = 1;
        row.expiresAt = iso(365 * DAY_MS);
      }
    };

    const summary = await run(database, bucket);

    expect(summary.deletedMovies).toBe(0);
    expect(bucket.deleted).toEqual([]);
    expect(database.movies.has('racePinAAAAA')).toBe(true);
  });

  it('期限内・期限未設定の動画には触れない', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'notExpiredAA', expiresAt: iso(HOUR_MS) }),
      movie({ shortId: 'noExpiryAAAA', expiresAt: null }),
    ]);
    const bucket = new FakeRetentionBucket();

    const summary = await run(database, bucket);

    expect(summary.deletedMovies).toBe(0);
    expect(bucket.deleted).toEqual([]);
    expect(database.movies.size).toBe(2);
  });

  it('R2 の削除に失敗した動画は D1 の行を残し、他の動画は処理を続ける', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'r2FailureAAA', expiresAt: iso(-HOUR_MS) }),
      movie({ shortId: 'r2OkayAAAAAA', expiresAt: iso(-HOUR_MS) }),
    ]);
    const bucket = new FakeRetentionBucket();
    bucket.failingKeys.add(movieKey('r2FailureAAA'));

    const summary = await run(database, bucket);

    expect(summary.deletedMovies).toBe(1);
    expect(database.movies.has('r2FailureAAA')).toBe(true);
    expect(database.movies.has('r2OkayAAAAAA')).toBe(false);
  });
});

describe('runRetention: pending 孤児と failed', () => {
  it('24h を過ぎた pending は実体があれば消してから行を削除する', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'orphanAAAAAA', status: 'pending', createdAt: iso(-DAY_MS - HOUR_MS) }),
    ]);
    const bucket = new FakeRetentionBucket(new Set([movieKey('orphanAAAAAA')]));

    const summary = await run(database, bucket);

    expect(summary.deletedOrphans).toBe(1);
    expect(bucket.deleted).toEqual([movieKey('orphanAAAAAA')]);
    expect(database.movies.size).toBe(0);
  });

  it('実体のない pending は R2 を触らずに行だけ削除する', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'noObjectAAAA', status: 'pending', createdAt: iso(-2 * DAY_MS) }),
    ]);
    const bucket = new FakeRetentionBucket();

    const summary = await run(database, bucket);

    expect(summary.deletedOrphans).toBe(1);
    expect(bucket.deleted).toEqual([]);
    expect(database.movies.size).toBe(0);
  });

  it('24h 以内の pending は残す', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'freshPendAAA', status: 'pending', createdAt: iso(-HOUR_MS) }),
    ]);
    const bucket = new FakeRetentionBucket();

    const summary = await run(database, bucket);

    expect(summary.deletedOrphans).toBe(0);
    expect(database.movies.size).toBe(1);
  });

  it('24h を過ぎた failed だけを削除する', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'oldFailedAAA', status: 'failed', createdAt: iso(-2 * DAY_MS) }),
      movie({ shortId: 'newFailedAAA', status: 'failed', createdAt: iso(-HOUR_MS) }),
    ]);
    const bucket = new FakeRetentionBucket();

    const summary = await run(database, bucket);

    expect(summary.deletedFailed).toBe(1);
    expect(database.movies.has('oldFailedAAA')).toBe(false);
    expect(database.movies.has('newFailedAAA')).toBe(true);
  });
});

describe('runRetention: captures', () => {
  it('prefix が contracts の captureKey と一致する', () => {
    expect(captureKey('11111111-2222-3333-4444-555555555555', 0).startsWith(CAPTURE_KEY_PREFIX)).toBe(
      true
    );
  });

  it('24h ちょうどは残し、それより古いものだけ消す（境界）', async () => {
    const boundary = captureObject(0, -DAY_MS);
    const older = captureObject(1, -DAY_MS - 1);
    const bucket = new FakeRetentionBucket(new Set(), [
      { objects: [boundary, older], truncated: false },
    ]);

    const summary = await run(new FakeRetentionDatabase([]), bucket);

    expect(summary.deletedCaptures).toBe(1);
    expect(bucket.deleted).toEqual([older.key]);
  });

  it('cursor を辿って次ページも削除する', async () => {
    const first = captureObject(0, -2 * DAY_MS);
    const second = captureObject(1, -2 * DAY_MS);
    const bucket = new FakeRetentionBucket(new Set(), [
      { objects: [first], truncated: true, cursor: '1' },
      { objects: [second], truncated: false },
    ]);

    const summary = await run(new FakeRetentionDatabase([]), bucket);

    expect(summary.deletedCaptures).toBe(2);
    expect(bucket.listCalls).toEqual([undefined, '1']);
    expect(bucket.deleted).toEqual([first.key, second.key]);
  });

  it('1 回の実行で上限件数まで消し、残りは次回に回す', async () => {
    const pageSize = 600;
    const page = (cursor: string | undefined): RetentionListResult => ({
      objects: Array.from({ length: pageSize }, (_, index) => captureObject(index, -2 * DAY_MS)),
      truncated: true,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const bucket = new FakeRetentionBucket(new Set(), [page('1'), page('2'), page('3')]);

    const summary = await run(new FakeRetentionDatabase([]), bucket);

    expect(summary.deletedCaptures).toBe(MAX_CAPTURE_DELETIONS_PER_RUN);
    expect(bucket.deleted).toHaveLength(MAX_CAPTURE_DELETIONS_PER_RUN);
    expect(bucket.listCalls).toEqual([undefined, '1']);
  });
});

describe('runRetention: サマリ', () => {
  it('4 種類の削除件数をまとめて返す', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'expiredBBBBB', expiresAt: iso(-HOUR_MS) }),
      movie({ shortId: 'orphanBBBBBB', status: 'pending', createdAt: iso(-2 * DAY_MS) }),
      movie({ shortId: 'failedBBBBBB', status: 'failed', createdAt: iso(-2 * DAY_MS) }),
    ]);
    const bucket = new FakeRetentionBucket(new Set(), [
      { objects: [captureObject(0, -2 * DAY_MS)], truncated: false },
    ]);

    const summary = await run(database, bucket);

    expect(summary).toEqual({
      deletedMovies: 1,
      deletedOrphans: 1,
      deletedFailed: 1,
      deletedCaptures: 1,
    });
    expect(database.movies.size).toBe(0);
  });

  it('created_at が SQLite 既定の表記でも ISO の閾値と比較できる', async () => {
    const database = new FakeRetentionDatabase([
      movie({
        shortId: 'sqliteFmtAAA',
        status: 'failed',
        createdAt: iso(-2 * DAY_MS).replace('T', ' ').slice(0, 19),
      }),
    ]);

    const summary = await run(database, new FakeRetentionBucket());

    expect(summary.deletedFailed).toBe(1);
  });
});
