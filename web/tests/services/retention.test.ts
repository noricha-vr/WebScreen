import { describe, expect, it } from 'bun:test';

import { movieKey } from '../../src/lib/contracts/r2key';
import { PRESIGN_TTL_MS } from '../../src/lib/infra/r2presign';
import {
  MAX_EXPIRED_DELETIONS_PER_RUN,
  MAX_FAILED_DELETIONS_PER_RUN,
} from '../../src/lib/services/retention';
import {
  captureObject,
  DAY_MS,
  FakeRetentionBucket,
  FakeRetentionDatabase,
  HOUR_MS,
  iso,
  movie,
  NOW,
  run,
} from './helpers/retention-fakes';

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
    // 黙って飛ばさず、件数として cron のログに出す。
    expect(summary.skippedRows).toBe(1);
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
    expect(summary.deferredObjectDeletions).toBe(1);
    expect(database.movies.has('r2FailureAAA')).toBe(true);
    expect(database.movies.has('r2OkayAAAAAA')).toBe(false);
  });
});

describe('runRetention: failed アップロード', () => {
  const earlyCleanupGraceMs = PRESIGN_TTL_MS + 60_000;

  it('TTL + 60秒より新しい行と境界上の行は R2 実体を掃除しない', async () => {
    const freshShortId = 'freshFail001';
    const boundaryShortId = 'boundFail001';
    const freshKey = movieKey(freshShortId);
    const boundaryKey = movieKey(boundaryShortId);
    const database = new FakeRetentionDatabase([
      movie({
        shortId: freshShortId,
        status: 'failed',
        createdAt: iso(-(earlyCleanupGraceMs - 1_000)),
        expiresAt: iso(30 * DAY_MS),
      }),
      movie({
        shortId: boundaryShortId,
        status: 'failed',
        createdAt: iso(-earlyCleanupGraceMs),
        expiresAt: iso(30 * DAY_MS),
      }),
    ]);
    const bucket = new FakeRetentionBucket(new Set([freshKey, boundaryKey]));

    const summary = await run(database, bucket);

    expect(summary.deletedFailed).toBe(0);
    expect(summary.sweptFailedObjects).toBe(0);
    expect(database.movies.size).toBe(2);
    expect(bucket.objects).toEqual(new Set([freshKey, boundaryKey]));
  });

  it('TTL + 60秒を過ぎた failed 行は R2 実体だけを早期回収する', async () => {
    const shortId = 'delayedPut01';
    const key = movieKey(shortId);
    const createdAt = iso(-(earlyCleanupGraceMs + 1_000));
    const database = new FakeRetentionDatabase([
      movie({ shortId, status: 'failed', createdAt, expiresAt: null }),
    ]);
    const bucket = new FakeRetentionBucket(new Set([key]));

    const summary = await run(database, bucket);

    expect(summary.deletedFailed).toBe(0);
    expect(summary.sweptFailedObjects).toBe(1);
    expect(bucket.objects.has(key)).toBe(false);
    expect(database.movies.has(shortId)).toBe(true);
    expect(database.movies.get(shortId)?.expiresAt).toBe(NOW.toISOString());
  });

  it('上限超過時も最終 sweep の古い行から巡回し、次の run で残りへ進む', async () => {
    const count = MAX_FAILED_DELETIONS_PER_RUN + 1;
    const failed = Array.from({ length: count }, (_unused, index) =>
      movie({
        shortId: `early${String(index).padStart(7, '0')}`,
        status: 'failed',
        createdAt: iso(-(earlyCleanupGraceMs + 1_000)),
        expiresAt: iso(30 * DAY_MS),
      })
    );
    const overflow = failed.at(-1)!;
    const overflowKey = movieKey(overflow.shortId);
    const database = new FakeRetentionDatabase(failed);
    const bucket = new FakeRetentionBucket(new Set(failed.map((row) => movieKey(row.shortId))));

    const first = await run(database, bucket);
    expect(first.sweptFailedObjects).toBe(MAX_FAILED_DELETIONS_PER_RUN);
    expect(first.sweepCapped).toBe(true);
    expect(bucket.objects.has(overflowKey)).toBe(true);

    const secondNow = new Date(NOW.getTime() + HOUR_MS);
    const second = await run(database, bucket, undefined, secondNow);

    expect(second.sweptFailedObjects).toBe(MAX_FAILED_DELETIONS_PER_RUN);
    expect(bucket.objects.has(overflowKey)).toBe(false);
    expect(database.movies.size).toBe(count);
    expect(database.movies.get(overflow.shortId)?.expiresAt).toBe(secondNow.toISOString());
  });

  it('初回削除後に遅延 PUT が完了しても、次の run で再回収する', async () => {
    const shortId = 'lateFinish01';
    const key = movieKey(shortId);
    const expiresAt = iso(30 * DAY_MS);
    const database = new FakeRetentionDatabase([
      movie({
        shortId,
        status: 'failed',
        createdAt: iso(-(earlyCleanupGraceMs + 1_000)),
        expiresAt,
      }),
    ]);
    const bucket = new FakeRetentionBucket(new Set([key]));

    const first = await run(database, bucket);
    expect(first.sweptFailedObjects).toBe(1);
    expect(bucket.objects.has(key)).toBe(false);

    // 署名失効直前に始まった PUT が、初回 delete の後に完了する。
    bucket.objects.add(key);
    const secondNow = new Date(NOW.getTime() + HOUR_MS);
    const second = await run(database, bucket, undefined, secondNow);

    expect(second.sweptFailedObjects).toBe(1);
    expect(bucket.objects.has(key)).toBe(false);
    expect(database.movies.get(shortId)).toMatchObject({
      status: 'failed',
      expiresAt: secondNow.toISOString(),
    });
  });

  it('早期回収の R2 削除失敗は次の run で再試行する', async () => {
    const shortId = 'retryFail001';
    const key = movieKey(shortId);
    const expiresAt = iso(30 * DAY_MS);
    const database = new FakeRetentionDatabase([
      movie({
        shortId,
        status: 'failed',
        createdAt: iso(-(earlyCleanupGraceMs + 1_000)),
        expiresAt,
      }),
    ]);
    const bucket = new FakeRetentionBucket(new Set([key]));
    bucket.failingKeys.add(key);

    const first = await run(database, bucket);
    expect(first.sweptFailedObjects).toBe(0);
    expect(first.deferredObjectDeletions).toBe(1);
    expect(database.movies.get(shortId)?.expiresAt).toBe(expiresAt);

    bucket.failingKeys.clear();
    const second = await run(database, bucket);
    expect(second.sweptFailedObjects).toBe(1);
    expect(second.deferredObjectDeletions).toBe(0);
    expect(database.movies.get(shortId)?.expiresAt).toBe(NOW.toISOString());
    expect(bucket.objects.has(key)).toBe(false);
  });

  it('R2 回収後の最終 sweep 時刻更新失敗は run を失敗させる', async () => {
    const shortId = 'sweepFail001';
    const key = movieKey(shortId);
    const expiresAt = iso(30 * DAY_MS);
    const database = new FakeRetentionDatabase([
      movie({
        shortId,
        status: 'failed',
        createdAt: iso(-(earlyCleanupGraceMs + 1_000)),
        expiresAt,
      }),
    ]);
    database.failSweepUpdate = true;
    const bucket = new FakeRetentionBucket(new Set([key]));

    await expect(run(database, bucket)).rejects.toThrow('D1 sweep timestamp update failed');

    expect(bucket.objects.has(key)).toBe(false);
    expect(database.movies.get(shortId)?.expiresAt).toBe(expiresAt);

    database.failSweepUpdate = false;
    const retryNow = new Date(NOW.getTime() + HOUR_MS);
    const retry = await run(database, bucket, undefined, retryNow);

    expect(retry.sweptFailedObjects).toBe(1);
    expect(bucket.deleted.filter((deletedKey) => deletedKey === key)).toHaveLength(2);
    expect(database.movies.get(shortId)?.expiresAt).toBe(retryNow.toISOString());
  });
});

describe('runRetention: 1 回の実行の上限', () => {
  it('期限切れ動画は上限件数までで打ち切り、残りは次回に回す', async () => {
    const expired = Array.from({ length: MAX_EXPIRED_DELETIONS_PER_RUN + 5 }, (_, index) =>
      movie({ shortId: `expired${String(index).padStart(5, '0')}`, expiresAt: iso(-HOUR_MS) })
    );
    const database = new FakeRetentionDatabase(expired);
    const bucket = new FakeRetentionBucket(new Set(expired.map((row) => movieKey(row.shortId))));

    const summary = await run(database, bucket);

    // subrequest の上限に収めるため、1 回の実行で触る行数を有限にする。
    expect(summary.deletedMovies).toBe(MAX_EXPIRED_DELETIONS_PER_RUN);
    expect(summary.sweepCapped).toBe(true);
    expect(database.movies.size).toBe(5);
  });
});

describe('runRetention: サマリ', () => {
  it('補完・pending 回収・各削除件数をまとめて返す', async () => {
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
      backfilledPinned: 0,
      deletedMovies: 1,
      strandedMovies: 0,
      recoveredPendingUploads: 1,
      deletedFailed: 1,
      sweptFailedObjects: 1,
      deferredObjectDeletions: 0,
      skippedRows: 0,
      sweepCapped: false,
      // 期限切れ・既存failedの削除・今回failed化したpending実体の3経路で purge する。
      cachePurgeRequests: 3,
      cachePurgeFailures: 0,
      deletedCaptures: 1,
      checkedReadyRows: 0,
      missingObjectRows: 0,
      auditErrors: 0,
    });
    expect(database.movies.get('orphanBBBBBB')?.status).toBe('failed');
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

describe('runRetention: pin 済みの期限補完', () => {
  it('期限を持たない pin 済みの行へ 1 年後の期限を入れる', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'pinnedNullAA', pinned: 1, expiresAt: null }),
    ]);

    const summary = await run(database, new FakeRetentionBucket());

    expect(summary.backfilledPinned).toBe(1);
    expect(database.movies.get('pinnedNullAA')?.expiresAt).toBe(iso(365 * DAY_MS));
    // 期限を入れた直後の行は同じ実行では消えない
    expect(database.movies.size).toBe(1);
  });

  it('期限を持つ行には触らない（pin 済みでも上書きしない）', async () => {
    const kept = iso(10 * DAY_MS);
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'pinnedDatedA', pinned: 1, expiresAt: kept }),
      movie({ shortId: 'plainDatedAA', pinned: 0, expiresAt: kept }),
    ]);

    const summary = await run(database, new FakeRetentionBucket());

    expect(summary.backfilledPinned).toBe(0);
    expect(database.movies.get('pinnedDatedA')?.expiresAt).toBe(kept);
    expect(database.movies.get('plainDatedAA')?.expiresAt).toBe(kept);
  });
});

describe('runRetention: 不変条件が破れた時の可視化', () => {
  it('R2 を消したのに行が残ったら stranded として数える', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'strandedAAAA', createdAt: iso(-HOUR_MS), expiresAt: iso(-HOUR_MS) }),
    ]);
    // 再確認の後・R2 削除の前に期限が延びる順序を再現する。togglePin は期限切れを
    // 410 で断るので本来起きないが、起きた時に黙らないことを固定する。
    const bucket = new FakeRetentionBucket(new Set([movieKey('strandedAAAA')]));
    const extend = (): void => {
      const target = database.movies.get('strandedAAAA');
      if (target) target.expiresAt = iso(365 * DAY_MS);
    };
    const originalDelete = bucket.delete.bind(bucket);
    bucket.delete = async (keys) => {
      extend();
      await originalDelete(keys);
    };

    const summary = await run(database, bucket);

    expect(summary.deletedMovies).toBe(0);
    expect(summary.strandedMovies).toBe(1);
    expect(database.movies.has('strandedAAAA')).toBe(true);
  });

  it('並行して行が消えていた場合は stranded に数えない', async () => {
    const database = new FakeRetentionDatabase([
      movie({ shortId: 'racedDeleteA', createdAt: iso(-HOUR_MS), expiresAt: iso(-HOUR_MS) }),
    ]);
    const bucket = new FakeRetentionBucket(new Set([movieKey('racedDeleteA')]));
    // 所有者の削除と競合しただけなら正常（実体も行も無くなる）
    const originalDelete = bucket.delete.bind(bucket);
    bucket.delete = async (keys) => {
      database.movies.delete('racedDeleteA');
      await originalDelete(keys);
    };

    const summary = await run(database, bucket);

    expect(summary.deletedMovies).toBe(0);
    expect(summary.strandedMovies).toBe(0);
  });
});

describe('runRetention: 削除直前の再確認', () => {
  it('SELECT 後に ready でなくなった行は R2 ごと消さない', async () => {
    const database = new FakeRetentionDatabase([
      // created_at を TTL + 60秒以内にして、後段の failed 実体回収とは分離する。
      movie({ shortId: 'statusFlipAA', createdAt: iso(-60_000), expiresAt: iso(-HOUR_MS) }),
    ]);
    // 期限切れとして拾った後に失敗扱いへ変わる（別経路の書き込みとの競合を再現）
    database.onSelect = (rows) => {
      for (const row of rows) {
        const target = database.movies.get(row.shortId);
        if (target) target.status = 'failed';
      }
    };
    const bucket = new FakeRetentionBucket(new Set([movieKey('statusFlipAA')]));

    const summary = await run(database, bucket);

    expect(summary.deletedMovies).toBe(0);
    expect(bucket.deleted).toEqual([]);
    expect(database.movies.has('statusFlipAA')).toBe(true);
  });
});
