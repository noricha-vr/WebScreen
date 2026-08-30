/**
 * 保持期間バッチのテストが共有する D1 / R2 のフェイク。
 *
 * フェイクだけを共有し、期待値は各テストファイルに直接書く（DAMP）。
 */

import { captureKey, movieKey } from '../../../src/lib/contracts/r2key';
import {
  MAX_FAILED_DELETIONS_PER_RUN,
  runRetention,
  type RetentionBucket,
  type RetentionDatabase,
} from '../../../src/lib/services/retention';
import {
  type CaptureListResult,
  type CaptureObject,
} from '../../../src/lib/services/retention-captures';

export const NOW = new Date('2026-08-25T12:00:00.000Z');
export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export type MovieStatus = 'pending' | 'ready' | 'failed';

export interface TestMovie {
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
export function parseSqliteTime(value: string): number {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  return Date.parse(/[Z+]|-\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
}

/** 掃除対象の条件（expires_at が設定済みで、かつ閾値より前）。 */
export function isExpired(movie: TestMovie, threshold: number): boolean {
  return movie.expiresAt !== null && parseSqliteTime(movie.expiresAt) < threshold;
}

export class FakeRetentionDatabase implements RetentionDatabase {
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
    // 監査のサンプル抽出（開始点以降の ready 行を N 件）。
    if (query.includes('short_id >= ?')) {
      return [...this.movies.values()]
        .filter((movie) => movie.status === 'ready' && movie.shortId >= (values[0] as string))
        .sort((left, right) => (left.shortId < right.shortId ? -1 : 1))
        .slice(0, values[1] as number)
        .map((movie) => ({ short_id: movie.shortId }));
    }

    // 削除直前の再確認（short_id と閾値の 2 引数）。pin ではなく status と期限で判定する。
    if (query.includes('WHERE short_id = ?')) {
      const movie = this.movies.get(values[0] as string);
      if (!movie) return [];
      // 引数が short_id だけなら行の存在確認（stranded と監査の判定に使う）
      if (values.length === 1) {
        if (query.includes("status = 'ready'") && movie.status !== 'ready') return [];
        return [{ short_id: movie.shortId }];
      }
      if (!isExpired(movie, parseSqliteTime(values[1] as string))) return [];
      if (query.includes("status = 'ready'") && movie.status !== 'ready') return [];
      return [{ short_id: movie.shortId }];
    }

    const threshold = parseSqliteTime(values[0] as string);
    const matched = [...this.movies.values()].filter((movie) => {
      if (query.includes("status = 'ready'")) return movie.status === 'ready' && isExpired(movie, threshold);
      const status = query.includes("status = 'failed'") ? 'failed' : 'pending';
      return movie.status === status && parseSqliteTime(movie.createdAt) < threshold;
    });
    const rows = query.includes('LIMIT ?') ? matched.slice(0, values[1] as number) : matched;
    this.onSelect?.(rows);
    return rows.map((movie) => ({ short_id: movie.shortId }));
  }

  private delete(query: string, values: unknown[]): number {
    // backfill の UPDATE も run() を通る。pin 済みで期限を持たない行だけを埋める。
    if (query.startsWith('UPDATE') && query.includes('expires_at = ?')) {
      const targets = [...this.movies.values()].filter(
        (movie) => movie.pinned === 1 && movie.expiresAt === null
      );
      for (const movie of targets) movie.expiresAt = values[0] as string;
      return targets.length;
    }

    // pending の確保（pending → failed）。commit と同じく status を条件に持つ。
    if (query.startsWith('UPDATE') && query.includes("SET status = 'failed'")) {
      const target = this.movies.get(values[0] as string);
      if (!target || target.status !== 'pending') return 0;
      if (parseSqliteTime(target.createdAt) >= parseSqliteTime(values[1] as string)) return 0;
      target.status = 'failed';
      return 1;
    }

    // failed のまとめ削除（DELETE ... short_id IN (?, ...)）。
    if (query.includes('short_id IN (')) {
      const targets = (values as string[]).filter(
        (shortId) => this.movies.get(shortId)?.status === 'failed'
      );
      for (const shortId of targets) this.movies.delete(shortId);
      return targets.length;
    }

    const movie = this.movies.get(values[0] as string);
    if (!movie) return 0;
    if (query.includes('expires_at') && !isExpired(movie, parseSqliteTime(values[1] as string))) {
      return 0;
    }
    if (query.includes("status = 'ready'") && movie.status !== 'ready') return 0;
    if (query.includes("status = 'failed'") && movie.status !== 'failed') return 0;
    this.movies.delete(movie.shortId);
    return 1;
  }
}

export class FakeRetentionBucket implements RetentionBucket {
  readonly deleted: string[] = [];
  readonly listCalls: (string | undefined)[] = [];
  /** delete が例外を投げるキー（R2 障害の再現）。 */
  failingKeys = new Set<string>();

  constructor(
    readonly objects = new Set<string>(),
    private readonly pages: CaptureListResult[] = [{ objects: [], truncated: false }]
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

  async list(options: { prefix: string; cursor?: string }): Promise<CaptureListResult> {
    this.listCalls.push(options.cursor);
    const index = options.cursor === undefined ? 0 : Number(options.cursor);
    return this.pages[index] ?? { objects: [], truncated: false };
  }
}

export function movie(overrides: Partial<TestMovie> & { shortId: string }): TestMovie {
  return {
    status: 'ready',
    pinned: 0,
    createdAt: new Date(NOW.getTime() - 40 * DAY_MS).toISOString(),
    expiresAt: null,
    ...overrides,
  };
}

export function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

export function captureObject(index: number, uploadedOffsetMs: number): CaptureObject {
  return {
    key: captureKey('11111111-2222-3333-4444-555555555555', index),
    uploaded: new Date(NOW.getTime() + uploadedOffsetMs),
  };
}

export async function run(database: FakeRetentionDatabase, bucket: FakeRetentionBucket) {
  return runRetention({ database, bucket, now: NOW });
}
