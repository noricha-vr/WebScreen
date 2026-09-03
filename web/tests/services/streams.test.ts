import { describe, expect, it } from 'bun:test';

import { ERROR_CODES } from '../../src/lib/contracts/api';
import {
  createStream,
  extendStream,
  getStreamStatus,
  heartbeatStream,
  stopAllLiveStreams,
  stopStream,
  type StreamSettings,
} from '../../src/lib/services/streams';
import {
  cancelStreamStart,
  MAX_STREAM_START_CANCELLATIONS_PER_USER,
} from '../../src/lib/services/stream-start';
import { createStreamDatabase } from './helpers/stream-db';

const NOW = new Date('2026-09-01T00:00:00.000Z');
const SETTINGS: StreamSettings = {
  whipOrigin: 'https://webscreen.tv',
  extensionCycleSeconds: 900,
  extensionEnabled: false,
  maxLiveStreamsPerUser: 1,
  maxLiveStreams: 20,
  createIntervalSeconds: 10,
};
const signer = async ({ expiresAtSeconds }: { expiresAtSeconds: number }) =>
  `token-exp-${expiresAtSeconds}`;
const START_TOKEN_A = '11111111-1111-4111-8111-111111111111';
const START_TOKEN_B = '22222222-2222-4222-9222-222222222222';

function input(database: Awaited<ReturnType<typeof createStreamDatabase>>, id: string, now = NOW) {
  return {
    database,
    userId: 10,
    settings: SETTINGS,
    signPublishToken: signer,
    generateId: () => id,
    now,
  };
}

describe('配信セッション service', () => {
  it('cancel先行ならcreateを409で拒否しliveも作らない', async () => {
    const database = await createStreamDatabase();
    await cancelStreamStart({ database, userId: 10, startToken: START_TOKEN_A, now: NOW });

    await expect(
      createStream({ ...input(database, 'AbCdEf123456'), startToken: START_TOKEN_A })
    ).rejects.toMatchObject({
      status: 409,
      errorCode: ERROR_CODES.streamStartCancelled,
    });
    expect(
      database.sqlite.query("SELECT COUNT(*) AS count FROM stream_sessions WHERE status = 'live'").get()
    ).toEqual({ count: 0 });
  });

  it('create先行なら同じtokenのliveだけをuser_stopで終了する', async () => {
    const database = await createStreamDatabase();
    await createStream({ ...input(database, 'AbCdEf123456'), startToken: START_TOKEN_A });

    await cancelStreamStart({ database, userId: 10, startToken: START_TOKEN_A, now: NOW });

    expect(
      database.sqlite
        .query('SELECT status, end_reason, kick_pending, start_token FROM stream_sessions')
        .get()
    ).toEqual({
      status: 'ended',
      end_reason: 'user_stop',
      kick_pending: 1,
      start_token: START_TOKEN_A,
    });
  });

  it('createとcancelが並行しても完了後のliveは0本になる', async () => {
    const database = await createStreamDatabase();
    await Promise.allSettled([
      createStream({ ...input(database, 'AbCdEf123456'), startToken: START_TOKEN_A }),
      cancelStreamStart({ database, userId: 10, startToken: START_TOKEN_A, now: NOW }),
    ]);

    expect(
      database.sqlite.query("SELECT COUNT(*) AS count FROM stream_sessions WHERE status = 'live'").get()
    ).toEqual({ count: 0 });
  });

  it('別tokenと別userのliveへキャンセルを波及させない', async () => {
    const database = await createStreamDatabase();
    await createStream({ ...input(database, 'AbCdEf123456'), startToken: START_TOKEN_A });
    await createStream({
      ...input(database, 'ZyXwVu987654'),
      userId: 20,
      startToken: START_TOKEN_A,
    });

    await cancelStreamStart({ database, userId: 10, startToken: START_TOKEN_B, now: NOW });
    await cancelStreamStart({ database, userId: 20, startToken: START_TOKEN_B, now: NOW });

    expect(
      database.sqlite
        .query("SELECT user_id, status FROM stream_sessions WHERE status = 'live' ORDER BY user_id")
        .all()
    ).toEqual([
      { user_id: 10, status: 'live' },
      { user_id: 20, status: 'live' },
    ]);
  });

  it('同じキャンセルを再送してもtombstoneは1件で対象は終了済みのまま', async () => {
    const database = await createStreamDatabase();
    await createStream({ ...input(database, 'AbCdEf123456'), startToken: START_TOKEN_A });

    await cancelStreamStart({ database, userId: 10, startToken: START_TOKEN_A, now: NOW });
    await cancelStreamStart({
      database,
      userId: 10,
      startToken: START_TOKEN_A,
      now: new Date(NOW.getTime() + 1_000),
    });

    expect(
      database.sqlite.query('SELECT COUNT(*) AS count FROM stream_start_cancellations').get()
    ).toEqual({ count: 1 });
    expect(
      database.sqlite.query('SELECT cancelled_at FROM stream_start_cancellations').get()
    ).toEqual({ cancelled_at: NOW.toISOString() });
    expect(database.sqlite.query('SELECT status FROM stream_sessions').get()).toEqual({
      status: 'ended',
    });
  });

  it('40 token burst後も利用者ごとに最新32件だけを保持する', async () => {
    const database = await createStreamDatabase();
    for (const userId of [10, 20]) {
      for (let index = 0; index < 40; index += 1) {
        await cancelStreamStart({
          database,
          userId,
          startToken: numberedStartToken(index),
          now: new Date(NOW.getTime() + index * 1_000),
        });
      }
    }
    const oldCurrentToken = numberedStartToken(99);
    const oldCancelledAt = new Date(NOW.getTime() - 1_000).toISOString();
    database.sqlite
      .query(
        `INSERT INTO stream_start_cancellations (user_id, start_token, cancelled_at)
         VALUES (10, ?, ?)`
      )
      .run(oldCurrentToken, oldCancelledAt);
    await cancelStreamStart({
      database,
      userId: 10,
      startToken: oldCurrentToken,
      now: new Date(NOW.getTime() + 100_000),
    });

    for (const userId of [10, 20]) {
      expect(
        database.sqlite
          .query('SELECT COUNT(*) AS count FROM stream_start_cancellations WHERE user_id = ?')
          .get(userId)
      ).toEqual({ count: MAX_STREAM_START_CANCELLATIONS_PER_USER });
      expect(
        database.sqlite
          .query(
            'SELECT start_token FROM stream_start_cancellations WHERE user_id = ? AND start_token = ?'
          )
          .get(userId, numberedStartToken(39))
      ).toEqual({ start_token: numberedStartToken(39) });
    }
    expect(
      database.sqlite
        .query('SELECT cancelled_at FROM stream_start_cancellations WHERE start_token = ?')
        .get(oldCurrentToken)
    ).toEqual({ cancelled_at: oldCancelledAt });
  });

  it('cancel先行は作成間隔を消費せず別tokenを直後に作成できる', async () => {
    const database = await createStreamDatabase();
    await cancelStreamStart({ database, userId: 10, startToken: START_TOKEN_A, now: NOW });

    await expect(
      createStream({ ...input(database, 'AbCdEf123456'), startToken: START_TOKEN_B })
    ).resolves.toMatchObject({ id: 'AbCdEf123456' });
  });

  it('start tokenのない旧クライアントは従来通り作成しNULLを保存する', async () => {
    const database = await createStreamDatabase();
    await createStream(input(database, 'AbCdEf123456'));

    expect(database.sqlite.query('SELECT start_token FROM stream_sessions').get()).toEqual({
      start_token: null,
    });
  });

  it('同じstart tokenのcreate再送を既存session状態に応じた409へ変換する', async () => {
    const liveDatabase = await createStreamDatabase();
    await createStream({ ...input(liveDatabase, 'AbCdEf123456'), startToken: START_TOKEN_A });
    await expect(
      createStream({ ...input(liveDatabase, 'ZyXwVu987654'), startToken: START_TOKEN_A })
    ).rejects.toMatchObject({ status: 409, errorCode: ERROR_CODES.streamAlreadyLive });

    const endedDatabase = await createStreamDatabase();
    await createStream({ ...input(endedDatabase, 'AbCdEf123456'), startToken: START_TOKEN_A });
    await stopStream({ database: endedDatabase, userId: 10, id: 'AbCdEf123456', now: NOW });
    await expect(
      createStream({
        ...input(endedDatabase, 'ZyXwVu987654', new Date(NOW.getTime() + 11_000)),
        startToken: START_TOKEN_A,
      })
    ).rejects.toMatchObject({ status: 409, errorCode: ERROR_CODES.streamEnded });
  });

  it('作成時刻を秒精度へ揃えD1・response・JWT NumericDateを一致させる', async () => {
    const database = await createStreamDatabase();
    let signedIssued = 0;
    let signedExpiry = 0;
    const response = await createStream({
      ...input(database, 'AbCdEf123456', new Date('2026-09-01T00:00:00.789Z')),
      signPublishToken: async ({ issuedAtSeconds, expiresAtSeconds }) => {
        signedIssued = issuedAtSeconds;
        signedExpiry = expiresAtSeconds;
        return 'token';
      },
    });
    const stored = database.sqlite
      .query('SELECT started_at, extend_expires_at FROM stream_sessions')
      .get() as { started_at: string; extend_expires_at: string };

    expect(response.startedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(response.extendExpiresAt).toBe('2026-09-01T00:15:00.000Z');
    expect(stored).toEqual({
      started_at: response.startedAt,
      extend_expires_at: response.extendExpiresAt,
    });
    expect(signedIssued * 1000).toBe(Date.parse(response.startedAt));
    expect(signedExpiry * 1000).toBe(Date.parse(response.extendExpiresAt));
  });

  it('作成 API 相当は毎回新しい12文字 path ID と固定ホストのURLを発行する', async () => {
    const database = await createStreamDatabase();
    const first = await createStream(input(database, 'AbCdEf123456'));
    await stopStream({ database, userId: 10, id: first.id, now: NOW });
    const second = await createStream(
      input(database, 'ZyXwVu987654', new Date(NOW.getTime() + 11_000))
    );

    expect(first.id).not.toBe(second.id);
    expect(second.streamUrl).toBe('rtspt://webscreen.tv/live/ZyXwVu987654');
    expect(second.whipUrl).toBe('https://webscreen.tv/live/ZyXwVu987654/whip');
  });

  it('延長フラグ有効時は期限を15分後へ更新し同じexpの新publish JWTを返す', async () => {
    const database = await createStreamDatabase();
    await createStream(input(database, 'AbCdEf123456'));
    const extendedAt = new Date('2026-09-01T00:10:00.789Z');
    let signedIssued = 0;
    let signedExpiry = 0;
    const response = await extendStream({
      ...input(database, 'ignored00000', extendedAt),
      id: 'AbCdEf123456',
      settings: { ...SETTINGS, extensionEnabled: true },
      signPublishToken: async ({ issuedAtSeconds, expiresAtSeconds }) => {
        signedIssued = issuedAtSeconds;
        signedExpiry = expiresAtSeconds;
        return `token-exp-${expiresAtSeconds}`;
      },
    });

    expect(response.extendExpiresAt).toBe('2026-09-01T00:25:00.000Z');
    expect(response.publishTokenExpiresAt).toBe(response.extendExpiresAt);
    expect(response.whipUrl).toBe('https://webscreen.tv/live/AbCdEf123456/whip');
    expect(response.publishToken).toBe(`token-exp-${Date.parse(response.extendExpiresAt) / 1000}`);
    expect(
      database.sqlite.query('SELECT extend_expires_at FROM stream_sessions').get()
    ).toEqual({ extend_expires_at: response.extendExpiresAt });
    expect(signedIssued * 1000).toBe(Date.parse('2026-09-01T00:10:00.000Z'));
    expect(signedExpiry * 1000).toBe(Date.parse(response.extendExpiresAt));
  });

  it('延長フラグ無効時は期限もpublish JWTも更新せず409で拒否する', async () => {
    const database = await createStreamDatabase();
    await createStream(input(database, 'AbCdEf123456'));
    const before = database.sqlite.query('SELECT extend_expires_at FROM stream_sessions').get();
    let signerCalls = 0;
    await expect(extendStream({ ...input(database, 'ignored00000', new Date('2026-09-01T00:10:00.000Z')), id: 'AbCdEf123456', signPublishToken: async () => { signerCalls += 1; return 'unexpected-token'; } })).rejects.toMatchObject({ status: 409, errorCode: ERROR_CODES.streamExtensionDisabled });
    expect(database.sqlite.query('SELECT extend_expires_at FROM stream_sessions').get()).toEqual(before);
    expect(signerCalls).toBe(0);
  });

  it('1ユーザーのlive 2本目を409で拒否する', async () => {
    const database = await createStreamDatabase();
    await createStream(input(database, 'AbCdEf123456'));
    await expect(createStream(input(database, 'ZyXwVu987654'))).rejects.toMatchObject({
      status: 409,
      errorCode: ERROR_CODES.streamAlreadyLive,
    });
  });

  it('同時作成でも原子的に1本だけをliveとして確保する', async () => {
    const database = await createStreamDatabase();
    const results = await Promise.allSettled([
      createStream(input(database, 'AbCdEf123456')),
      createStream(input(database, 'ZyXwVu987654')),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      database.sqlite.query("SELECT COUNT(*) AS count FROM stream_sessions WHERE status='live'").get()
    ).toEqual({ count: 1 });
  });

  it('設定を変えれば2本まで許可し作成間隔も1秒へ変わる', async () => {
    const database = await createStreamDatabase();
    const settings = { ...SETTINGS, maxLiveStreamsPerUser: 2, createIntervalSeconds: 1 };
    await createStream({ ...input(database, 'AbCdEf123456'), settings });
    await expect(
      createStream({
        ...input(database, 'ZyXwVu987654', new Date(NOW.getTime() + 2_000)),
        settings,
      })
    ).resolves.toMatchObject({ id: 'ZyXwVu987654' });
  });

  it('全利用者のliveが20本なら21件目を429の容量エラーで拒否する', async () => {
    const database = await createStreamDatabase();
    const settings = { ...SETTINGS, maxLiveStreamsPerUser: 21, maxLiveStreams: 20, createIntervalSeconds: 1 };
    for (let index = 0; index < 20; index += 1) {
      await createStream({
        ...input(database, `AbCdEf${String(index).padStart(6, '0')}`, new Date(NOW.getTime() + index * 2_000)),
        settings,
      });
    }
    await expect(
      createStream({
        ...input(database, 'ZyXwVu999999', new Date(NOW.getTime() + 42_000)),
        settings,
      })
    ).rejects.toMatchObject({ status: 429, errorCode: ERROR_CODES.streamCapacityReached });
  });

  it('停止直後の再作成を10秒の間隔制限で429にする', async () => {
    const database = await createStreamDatabase();
    await createStream(input(database, 'AbCdEf123456'));
    await stopStream({ database, userId: 10, id: 'AbCdEf123456', now: NOW });
    await expect(createStream(input(database, 'ZyXwVu987654'))).rejects.toMatchObject({
      status: 429,
      errorCode: ERROR_CODES.streamCreateRateLimited,
    });
  });

  it('既存path IDとの衝突だけを有限回再試行する', async () => {
    const database = await createStreamDatabase();
    await createStream(input(database, 'AbCdEf123456'));
    await stopStream({ database, userId: 10, id: 'AbCdEf123456', now: NOW });
    const ids = ['AbCdEf123456', 'ZyXwVu987654'];
    const created = await createStream({
      ...input(database, 'ignored00000', new Date(NOW.getTime() + 11_000)),
      generateId: () => ids.shift()!,
    });
    expect(created.id).toBe('ZyXwVu987654');
  });

  it('期限切れliveを延長して復活させない', async () => {
    const database = await createStreamDatabase();
    await createStream(input(database, 'AbCdEf123456'));
    await expect(
      extendStream({
        ...input(database, 'ignored00000', new Date('2026-09-01T02:00:00.000Z')),
        id: 'AbCdEf123456',
        settings: { ...SETTINGS, extensionEnabled: true },
      })
    ).rejects.toMatchObject({ status: 409, errorCode: ERROR_CODES.streamEnded });
  });

  it('他人のIDは状態取得も停止も404として扱う', async () => {
    const database = await createStreamDatabase();
    await createStream(input(database, 'AbCdEf123456'));
    await expect(
      getStreamStatus({ database, userId: 20, id: 'AbCdEf123456' })
    ).rejects.toMatchObject({ status: 404, errorCode: ERROR_CODES.notFound });
    await expect(
      stopStream({ database, userId: 20, id: 'AbCdEf123456', now: NOW })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('heartbeatはliveだけ更新しendedを409、他人と不存在を404にする', async () => {
    const database = await createStreamDatabase();
    await createStream(input(database, 'AbCdEf123456'));
    const heartbeatAt = new Date('2026-09-01T00:01:00.123Z');
    await heartbeatStream({ database, userId: 10, id: 'AbCdEf123456', now: heartbeatAt });
    expect(
      database.sqlite.query('SELECT last_heartbeat_at FROM stream_sessions').get()
    ).toEqual({ last_heartbeat_at: heartbeatAt.toISOString() });

    await expect(
      heartbeatStream({ database, userId: 20, id: 'AbCdEf123456', now: heartbeatAt })
    ).rejects.toMatchObject({ status: 404, errorCode: ERROR_CODES.notFound });
    await expect(
      heartbeatStream({ database, userId: 10, id: 'Missing000001', now: heartbeatAt })
    ).rejects.toMatchObject({ status: 404, errorCode: ERROR_CODES.notFound });

    await stopStream({ database, userId: 10, id: 'AbCdEf123456', now: heartbeatAt });
    await expect(
      heartbeatStream({ database, userId: 10, id: 'AbCdEf123456', now: heartbeatAt })
    ).rejects.toMatchObject({ status: 409, errorCode: ERROR_CODES.streamEnded });
  });

  it('user_stopは終了理由とkick_pendingを記録し冪等に成功する', async () => {
    const database = await createStreamDatabase();
    await createStream(input(database, 'AbCdEf123456'));
    await stopStream({ database, userId: 10, id: 'AbCdEf123456', now: NOW });
    await stopStream({ database, userId: 10, id: 'AbCdEf123456', now: NOW });

    expect(await getStreamStatus({ database, userId: 10, id: 'AbCdEf123456' })).toMatchObject({
      status: 'ended',
      endReason: 'user_stop',
    });
    expect(
      database.sqlite.query('SELECT kick_pending FROM stream_sessions').get()
    ).toEqual({ kick_pending: 1 });
  });

  it('live 配信をすべて user_stop と kick_pending で終了し、停止件数を返す', async () => {
    const database = await createStreamDatabase();
    const settings = { ...SETTINGS, maxLiveStreamsPerUser: 2 };
    await createStream({ ...input(database, 'AbCdEf123456'), settings });
    await createStream({
      ...input(database, 'ZyXwVu987654', new Date(NOW.getTime() + 11_000)),
      settings,
    });

    const response = await stopAllLiveStreams({
      database,
      userId: 10,
      settings,
      now: new Date(NOW.getTime() + 15_000),
    });

    expect(response).toEqual({ stopped: 2, retryAfterSeconds: 6 });
    expect(
      database.sqlite.query(
        "SELECT status, ended_at, end_reason, kick_pending FROM stream_sessions WHERE user_id = 10 ORDER BY id"
      ).all()
    ).toEqual([
      {
        status: 'ended',
        ended_at: '2026-09-01T00:00:15.000Z',
        end_reason: 'user_stop',
        kick_pending: 1,
      },
      {
        status: 'ended',
        ended_at: '2026-09-01T00:00:15.000Z',
        end_reason: 'user_stop',
        kick_pending: 1,
      },
    ]);
  });

  it('最新の開始から間隔を過ぎた時とセッションがない時は待機不要にする', async () => {
    const database = await createStreamDatabase();
    await createStream(input(database, 'AbCdEf123456'));
    const afterInterval = await stopAllLiveStreams({
      database,
      userId: 10,
      settings: SETTINGS,
      now: new Date(NOW.getTime() + 10_000),
    });
    const noSessions = await stopAllLiveStreams({
      database,
      userId: 20,
      settings: SETTINGS,
      now: NOW,
    });

    expect(afterInterval.retryAfterSeconds).toBe(0);
    expect(noSessions).toEqual({ stopped: 0, retryAfterSeconds: 0 });
  });

  it('別ユーザーの live 配信は終了しない', async () => {
    const database = await createStreamDatabase();
    await createStream(input(database, 'AbCdEf123456'));
    await createStream({ ...input(database, 'ZyXwVu987654'), userId: 20 });

    await stopAllLiveStreams({ database, userId: 10, settings: SETTINGS, now: NOW });

    expect(
      database.sqlite.query('SELECT status FROM stream_sessions WHERE user_id = 20').get()
    ).toEqual({ status: 'live' });
  });
});

function numberedStartToken(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}
