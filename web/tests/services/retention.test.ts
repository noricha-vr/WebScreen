import { describe, expect, it } from 'bun:test';

import { movieKey } from '../../src/lib/contracts/r2key';
import { MAX_EXPIRED_DELETIONS_PER_RUN } from '../../src/lib/services/retention';
import {
  captureObject,
  DAY_MS,
  FakeRetentionBucket,
  FakeRetentionDatabase,
  HOUR_MS,
  iso,
  movie,
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
  it('補完と 4 種類の削除件数をまとめて返す', async () => {
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
      deletedOrphans: 1,
      deletedFailed: 1,
      deferredObjectDeletions: 0,
      skippedRows: 0,
      sweepCapped: false,
      // 期限切れ・孤児・failed の 3 経路がそれぞれ 1 回ずつ purge を投げる。
      cachePurgeRequests: 3,
      cachePurgeFailures: 0,
      deletedCaptures: 1,
      checkedReadyRows: 0,
      missingObjectRows: 0,
      auditErrors: 0,
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
      // created_at を新しくしておく（failed 行の掃除は 24 時間の猶予後なので、
      // ここで消えると再確認の効果か猶予切れかを区別できない）
      movie({ shortId: 'statusFlipAA', createdAt: iso(-HOUR_MS), expiresAt: iso(-HOUR_MS) }),
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
