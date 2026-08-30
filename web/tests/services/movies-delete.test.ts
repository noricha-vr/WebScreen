import { describe, expect, it } from 'bun:test';

import type { PurgeFetcher } from '../../src/lib/infra/cloudflare-purge';
import type { CachePurgeSettings } from '../../src/lib/services/cache-purge';
import {
  deleteMovie,
  type MovieBucket,
  type MoviesDatabase,
} from '../../src/lib/services/movies';

const USER_ID = 10;
const SHORT_ID = 'AbCdEf123456';
const MOVIE_KEY = `movies/${SHORT_ID}.mp4`;
const PUBLIC_BASE_URL = 'https://cdn.example';

/** purge の設定。fetcher を差し替えて実ネットワークを使わない。 */
function cachePurge(fetcher?: PurgeFetcher): CachePurgeSettings {
  return {
    publicBaseUrl: PUBLIC_BASE_URL,
    zoneId: '2210192b51f9f0eb6761d70341ca09b0',
    apiToken: 'test-token',
    source: 'test-worker',
    fetcher: fetcher ?? (() => Promise.resolve(new Response(null, { status: 200 }))),
  };
}

/** deleteMovie が使う 2 文（所有者の SELECT と DELETE）だけを持つ最小のフェイク。 */
class FakeMoviesDatabase implements MoviesDatabase {
  deletedRows = 0;

  constructor(private readonly failDelete = false) {}

  prepare(query: string) {
    const isDelete = query.startsWith('DELETE');
    return {
      bind: () => ({
        first: async <T>(): Promise<T | null> =>
          ({
            short_id: SHORT_ID,
            user_id: USER_ID,
            filename: 'movie.mp4',
            status: 'ready',
            pinned: 0,
            created_at: '2026-08-25 12:00:00',
            expires_at: null,
          }) as T,
        all: async <T>(): Promise<{ results: T[] }> => ({ results: [] }),
        run: async (): Promise<{ meta: { changes: number } }> => {
          if (isDelete && this.failDelete) throw new Error('D1 unavailable');
          if (isDelete) this.deletedRows += 1;
          return { meta: { changes: 1 } };
        },
      }),
    };
  }
}

class FakeMovieBucket implements MovieBucket {
  readonly deletedKeys: string[] = [];

  async delete(key: string): Promise<void> {
    this.deletedKeys.push(key);
  }
}

/** purge の失敗ログ（console.warn の 1 行 JSON）を集める。 */
async function captureWarnLogs(run: () => Promise<void>): Promise<string[]> {
  const original = console.warn;
  const entries: string[] = [];
  console.warn = (entry: unknown) => {
    entries.push(String(entry));
  };
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return entries;
}

/** logWorkerFailure が error で出した event 名だけを集める。 */
async function captureErrorEvents(run: () => Promise<void>): Promise<string[]> {
  const original = console.error;
  const events: string[] = [];
  console.error = ((entry: string) => events.push(JSON.parse(entry).event)) as typeof console.error;
  try {
    await run();
  } finally {
    console.error = original;
  }
  return events;
}

describe('deleteMovie', () => {
  it('R2 を消した後に行の削除が失敗したら、実体の無い行が残ったことをログに残す', async () => {
    const database = new FakeMoviesDatabase(true);
    const bucket = new FakeMovieBucket();

    const events = await captureErrorEvents(async () => {
      await expect(
        deleteMovie({
          database,
          bucket,
          cachePurge: cachePurge(),
          userId: USER_ID,
          shortId: SHORT_ID,
        })
      ).rejects.toThrow('D1 unavailable');
    });

    // 実体だけが消え、ready の行が残る（プレビューが再生不能になる）状態。
    expect(bucket.deletedKeys).toEqual([MOVIE_KEY]);
    expect(events).toEqual(['movie_delete_row_stranded']);
  });

  it('削除が成功した時はログを出さない', async () => {
    const database = new FakeMoviesDatabase();
    const bucket = new FakeMovieBucket();

    const events = await captureErrorEvents(async () => {
      await deleteMovie({
        database,
        bucket,
        cachePurge: cachePurge(),
        userId: USER_ID,
        shortId: SHORT_ID,
      });
    });

    expect(events).toEqual([]);
    expect(database.deletedRows).toBe(1);
    expect(bucket.deletedKeys).toEqual([MOVIE_KEY]);
  });

  it('公開 URL のキャッシュ purge を 1 回投げる', async () => {
    const database = new FakeMoviesDatabase();
    const bucket = new FakeMovieBucket();
    const batches: string[][] = [];

    await deleteMovie({
      database,
      bucket,
      cachePurge: cachePurge((_url, init) => {
        batches.push((JSON.parse(String(init?.body)) as { files: string[] }).files);
        return Promise.resolve(new Response(null, { status: 200 }));
      }),
      userId: USER_ID,
      shortId: SHORT_ID,
    });

    expect(batches).toEqual([[`${PUBLIC_BASE_URL}/${MOVIE_KEY}`]]);
  });

  it('purge が例外を投げても削除は成功する（DELETE は 204 を返す）', async () => {
    const database = new FakeMoviesDatabase();
    const bucket = new FakeMovieBucket();

    await captureWarnLogs(async () => {
      await deleteMovie({
        database,
        bucket,
        cachePurge: cachePurge(() => Promise.reject(new Error('purge unreachable'))),
        userId: USER_ID,
        shortId: SHORT_ID,
      });
    });

    expect(bucket.deletedKeys).toEqual([MOVIE_KEY]);
    expect(database.deletedRows).toBe(1);
  });

  it('purge が非 2xx を返しても削除は成功する', async () => {
    const database = new FakeMoviesDatabase();
    const bucket = new FakeMovieBucket();

    const logs = await captureWarnLogs(async () => {
      await deleteMovie({
        database,
        bucket,
        cachePurge: cachePurge(() => Promise.resolve(new Response('nope', { status: 403 }))),
        userId: USER_ID,
        shortId: SHORT_ID,
      });
    });

    expect(database.deletedRows).toBe(1);
    // infra の失敗に続けて、削除経路として気づける 1 行も残す。
    expect(logs.map((line) => JSON.parse(line).event)).toEqual([
      'cache_purge_failed',
      'movie_delete_cache_purge_failed',
    ]);
  });
});
