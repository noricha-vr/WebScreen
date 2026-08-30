import { describe, expect, it } from 'bun:test';

import { movieKey } from '../../src/lib/contracts/r2key';
import { MAX_FAILED_DELETIONS_PER_RUN } from '../../src/lib/services/retention';
import {
  DAY_MS,
  FakeRetentionBucket,
  FakeRetentionDatabase,
  HOUR_MS,
  iso,
  movie,
  run,
} from './helpers/retention-fakes';

describe('runRetention: pending 孤児と failed', () => {
  it('24h を過ぎた pending は行を確保してから実体を消す', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'orphanAAAAAA', status: 'pending', createdAt: iso(-DAY_MS - HOUR_MS) }),
    ]);
    const bucket = new FakeRetentionBucket(new Set([movieKey('orphanAAAAAA')]));

    const summary = await run(database, bucket);

    expect(summary.deletedOrphans).toBe(1);
    expect(bucket.deleted).toEqual([movieKey('orphanAAAAAA')]);
    expect(database.movies.size).toBe(0);
  });

  it('SELECT 後に commit が確定した pending は R2 を消さず ready のまま残す', async () => {
    const database = new FakeRetentionDatabase([
      movie({
        shortId: 'raceCommitAA',
        status: 'pending',
        createdAt: iso(-DAY_MS - HOUR_MS),
        expiresAt: iso(30 * DAY_MS),
      }),
    ]);
    const bucket = new FakeRetentionBucket(new Set([movieKey('raceCommitAA')]));
    // SELECT 直後に所有者の commit が通った状況（pending → ready）。
    database.onSelect = (rows) => {
      for (const row of rows) row.status = 'ready';
    };

    const summary = await run(database, bucket);

    expect(summary.deletedOrphans).toBe(0);
    expect(summary.skippedRows).toBe(1);
    expect(bucket.deleted).toEqual([]);
    expect(database.movies.get('raceCommitAA')?.status).toBe('ready');
  });

  it('確保後に R2 の削除が失敗した pending は failed 行として残り、次回の実行で回収される', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'orphanFailAA', status: 'pending', createdAt: iso(-2 * DAY_MS) }),
    ]);
    const bucket = new FakeRetentionBucket(new Set([movieKey('orphanFailAA')]));
    bucket.failingKeys.add(movieKey('orphanFailAA'));

    const first = await run(database, bucket);

    expect(first.deletedOrphans).toBe(0);
    expect(first.deferredObjectDeletions).toBe(1);
    expect(bucket.deleted).toEqual([]);
    expect(database.movies.get('orphanFailAA')?.status).toBe('failed');

    // R2 が復旧した次の実行で、実体を消してから行を消す。
    bucket.failingKeys.clear();
    const second = await run(database, bucket);

    expect(second.deletedFailed).toBe(1);
    expect(second.deferredObjectDeletions).toBe(0);
    expect(bucket.deleted).toEqual([movieKey('orphanFailAA')]);
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

  it('上限を超える failed 行は上限分だけ処理し、残りは次回へ持ち越す', async () => {
    const overflow = 2;
    const database = new FakeRetentionDatabase(
      Array.from({ length: MAX_FAILED_DELETIONS_PER_RUN + overflow }, (_, index) =>
        movie({
          shortId: `failed${String(index).padStart(6, '0')}`,
          status: 'failed',
          createdAt: iso(-2 * DAY_MS),
        })
      )
    );
    const bucket = new FakeRetentionBucket();

    const summary = await run(database, bucket);

    expect(summary.deletedFailed).toBe(MAX_FAILED_DELETIONS_PER_RUN);
    expect(summary.sweepCapped).toBe(true);
    expect(bucket.deleted).toHaveLength(MAX_FAILED_DELETIONS_PER_RUN);
    expect(database.movies.size).toBe(overflow);
  });
});
