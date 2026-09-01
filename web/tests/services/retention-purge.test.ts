import { describe, expect, it } from 'bun:test';

import { movieUrl } from '../../src/lib/contracts/r2key';
import { MAX_URLS_PER_PURGE } from '../../src/lib/infra/cloudflare-purge';
import { PRESIGN_TTL_MS } from '../../src/lib/infra/r2presign';
import { MAX_FAILED_DELETIONS_PER_RUN } from '../../src/lib/services/retention';
import {
  DAY_MS,
  FakeCachePurgeApi,
  FakeRetentionBucket,
  FakeRetentionDatabase,
  HOUR_MS,
  iso,
  movie,
  PUBLIC_BASE_URL,
  run,
} from './helpers/retention-fakes';

/** purge に載った URL を、経路をまたいで 1 本の配列にする。 */
function purgedUrls(api: FakeCachePurgeApi): string[] {
  return api.batches.flat();
}

describe('runRetention: キャッシュ purge', () => {
  it('期限切れで消した動画の公開 URL を purge する', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'expiredAAAAA', expiresAt: iso(-HOUR_MS) }),
    ]);
    const api = new FakeCachePurgeApi();

    const summary = await run(database, new FakeRetentionBucket(), api);

    expect(summary.deletedMovies).toBe(1);
    expect(purgedUrls(api)).toEqual([movieUrl(PUBLIC_BASE_URL, 'expiredAAAAA')]);
    expect(summary.cachePurgeFailures).toBe(0);
  });

  it('回収した pending の実体と既存 failed の削除をどちらも purge する', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'orphanAAAAAA', status: 'pending', createdAt: iso(-2 * DAY_MS) }),
      movie({ shortId: 'failedAAAAAA', status: 'failed', createdAt: iso(-2 * DAY_MS) }),
    ]);
    const api = new FakeCachePurgeApi();

    const summary = await run(database, new FakeRetentionBucket(), api);

    expect(summary.recoveredPendingUploads).toBe(1);
    expect(summary.deletedFailed).toBe(1);
    expect(summary.sweptFailedObjects).toBe(1);
    expect(purgedUrls(api).sort()).toEqual(
      [
        movieUrl(PUBLIC_BASE_URL, 'orphanAAAAAA'),
        movieUrl(PUBLIC_BASE_URL, 'failedAAAAAA'),
      ].sort()
    );
    expect(database.movies.get('orphanAAAAAA')?.status).toBe('failed');
  });

  it('failed 実体の早期回収でも公開 URL を purge し、D1 行は残す', async () => {
    const shortId = 'earlyFailAAA';
    const database = new FakeRetentionDatabase([
      movie({
        shortId,
        status: 'failed',
        createdAt: iso(-(PRESIGN_TTL_MS + 61_000)),
        expiresAt: iso(30 * DAY_MS),
      }),
    ]);
    const api = new FakeCachePurgeApi();

    const summary = await run(database, new FakeRetentionBucket(), api);

    expect(summary.sweptFailedObjects).toBe(1);
    expect(summary.deletedFailed).toBe(0);
    expect(database.movies.has(shortId)).toBe(true);
    expect(purgedUrls(api)).toEqual([movieUrl(PUBLIC_BASE_URL, shortId)]);
  });

  it('30 件を超える掃除は 30 件ずつに分けて purge する', async () => {
    const count = MAX_URLS_PER_PURGE + 1;
    const database = new FakeRetentionDatabase(
      Array.from({ length: count }, (_unused, index) =>
        movie({
          shortId: `failed${String(index).padStart(6, '0')}`,
          status: 'failed',
          createdAt: iso(-2 * DAY_MS),
        })
      )
    );
    const api = new FakeCachePurgeApi();

    const summary = await run(database, new FakeRetentionBucket(), api);

    expect(summary.deletedFailed).toBe(count);
    expect(api.batches.map((batch) => batch.length)).toEqual([MAX_URLS_PER_PURGE, 1]);
    expect(summary.cachePurgeRequests).toBe(2);
    expect(purgedUrls(api)).toHaveLength(count);
    expect(count).toBeLessThan(MAX_FAILED_DELETIONS_PER_RUN);
  });

  it('purge が失敗しても掃除は続き、失敗の件数だけ残る', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'expiredAAAAA', expiresAt: iso(-HOUR_MS) }),
      movie({ shortId: 'failedAAAAAA', status: 'failed', createdAt: iso(-2 * DAY_MS) }),
    ]);
    const api = new FakeCachePurgeApi(500);
    const original = console.warn;
    console.warn = () => {};

    try {
      const summary = await run(database, new FakeRetentionBucket(), api);

      // 削除は完走する（キャッシュは最大 120 分で自然に切れる）。
      expect(summary.deletedMovies).toBe(1);
      expect(summary.deletedFailed).toBe(1);
      expect(database.movies.size).toBe(0);
      expect(summary.cachePurgeFailures).toBe(2);
    } finally {
      console.warn = original;
    }
  });

  it('R2 の削除に失敗した動画は purge しない（実体が残っているため）', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'expiredAAAAA', expiresAt: iso(-HOUR_MS) }),
    ]);
    const bucket = new FakeRetentionBucket();
    bucket.failingKeys.add('movies/expiredAAAAA.mp4');
    const api = new FakeCachePurgeApi();

    const summary = await run(database, bucket, api);

    expect(summary.deferredObjectDeletions).toBe(1);
    expect(api.batches).toEqual([]);
  });
});
