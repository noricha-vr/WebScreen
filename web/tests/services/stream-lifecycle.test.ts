import { describe, expect, it } from 'bun:test';

import type { MediaMtxClient, MediaMtxPublisher, MediaPath } from '../../src/lib/infra/mediamtx';
import { runStreamLifecycle } from '../../src/lib/services/stream-lifecycle';
import { createStreamDatabase, type StreamSqliteAdapter } from './helpers/stream-db';

const NOW = new Date('2026-09-01T02:00:00.000Z');
const SETTINGS = { noViewerTimeoutSeconds: 600, heartbeatTimeoutSeconds: 60 };

class FakeMediaMtx implements MediaMtxClient {
  kicks: string[] = [];
  constructor(readonly paths: MediaPath[] = [], readonly listFailure?: Error) {}
  async getPath(name: string): Promise<MediaPath | undefined> {
    return this.paths.find((path) => path.name === name);
  }
  async listPaths(): Promise<MediaPath[]> {
    if (this.listFailure) throw this.listFailure;
    return this.paths.map((path) => ({
      ...path,
      publisherSessionType:
        path.publisherId === null ? null : (path.publisherSessionType ?? 'webRTCSession'),
    }));
  }
  async kickPublisher(publisher: MediaMtxPublisher): Promise<void> {
    this.kicks.push(publisher.id);
  }
}

async function insertLive(
  database: StreamSqliteAdapter,
  input: { extendAt: string; heartbeatAt?: string; viewerAt?: string; id?: string }
): Promise<void> {
  const heartbeat = input.heartbeatAt ?? NOW.toISOString();
  database.sqlite
    .query(
      `INSERT INTO stream_sessions (
        id, user_id, status, started_at, extend_expires_at, last_heartbeat_at, last_viewer_at
      ) VALUES (?, 10, 'live', ?, ?, ?, ?)`
    )
    .run(
      input.id ?? 'AbCdEf123456',
      '2026-09-01T00:00:00.000Z',
      input.extendAt,
      heartbeat,
      input.viewerAt ?? heartbeat
    );
}

function lifecycle(database: StreamSqliteAdapter, mediaMtx: MediaMtxClient, now = NOW) {
  return runStreamLifecycle({ database, mediaMtx, settings: SETTINGS, now });
}

function row(database: StreamSqliteAdapter) {
  return database.sqlite
    .query('SELECT status, end_reason, last_viewer_at, kick_pending FROM stream_sessions')
    .get() as Record<string, unknown>;
}

describe('配信セッション lifecycle', () => {
  it('streamが0件でも24時間を超えた開始tombstoneだけを削除する', async () => {
    const database = await createStreamDatabase();
    database.sqlite
      .query(
        `INSERT INTO stream_start_cancellations (user_id, start_token, cancelled_at)
         VALUES (10, ?, ?), (10, ?, ?)`
      )
      .run(
        '11111111-1111-4111-8111-111111111111',
        '2026-08-31T01:59:59.999Z',
        '22222222-2222-4222-9222-222222222222',
        '2026-08-31T02:00:00.000Z'
      );

    const summary = await runStreamLifecycle({ database, settings: SETTINGS, now: NOW });

    expect(summary.deletedStartCancellations).toBe(1);
    expect(
      database.sqlite.query('SELECT start_token FROM stream_start_cancellations').all()
    ).toEqual([{ start_token: '22222222-2222-4222-9222-222222222222' }]);
  });

  it('延長期限に達したliveをextend_timeoutで終了しpublisherをkickする', async () => {
    const database = await createStreamDatabase();
    await insertLive(database, { extendAt: NOW.toISOString() });
    const media = new FakeMediaMtx([
      { name: 'live/AbCdEf123456', publisherId: 'publisher-1', rtspReaders: 1 },
    ]);
    const summary = await lifecycle(database, media);

    expect(row(database)).toMatchObject({ status: 'ended', end_reason: 'extend_timeout', kick_pending: 1 });
    expect(media.kicks).toEqual(['publisher-1']);
    expect(summary.endedByExtendTimeout).toBe(1);
  });

  it('RTSP readerゼロが10分継続したらno_viewersで終了する', async () => {
    const database = await createStreamDatabase();
    await insertLive(database, {
      extendAt: '2026-09-01T04:00:00.000Z',
      viewerAt: '2026-09-01T01:50:00.000Z',
    });
    await lifecycle(database, new FakeMediaMtx());
    expect(row(database)).toMatchObject({ status: 'ended', end_reason: 'no_viewers' });
  });

  it('9分時点でRTSP readerを観測したら猶予をリセットする', async () => {
    const database = await createStreamDatabase();
    await insertLive(database, {
      extendAt: '2026-09-01T04:00:00.000Z',
      viewerAt: '2026-09-01T01:51:00.000Z',
    });
    await lifecycle(
      database,
      new FakeMediaMtx([
        { name: 'live/AbCdEf123456', publisherId: 'publisher-1', rtspReaders: 1 },
      ])
    );
    expect(row(database)).toMatchObject({
      status: 'live',
      last_viewer_at: NOW.toISOString(),
    });
  });

  it('heartbeatが60秒途絶えたらheartbeat_lostで終了する', async () => {
    const database = await createStreamDatabase();
    await insertLive(database, {
      extendAt: '2026-09-01T04:00:00.000Z',
      heartbeatAt: '2026-09-01T01:59:00.000Z',
    });
    await lifecycle(database, new FakeMediaMtx());
    expect(row(database)).toMatchObject({ status: 'ended', end_reason: 'heartbeat_lost' });
  });

  it('MediaMTX障害でもheartbeat終了を先に記録して失敗を再送出する', async () => {
    const database = await createStreamDatabase();
    await insertLive(database, {
      extendAt: '2026-09-01T04:00:00.000Z',
      heartbeatAt: '2026-09-01T01:59:00.000Z',
    });
    await expect(lifecycle(database, new FakeMediaMtx([], new Error('unavailable')))).rejects.toThrow(
      'unavailable'
    );
    expect(row(database)).toMatchObject({ status: 'ended', end_reason: 'heartbeat_lost' });
  });

  it('kick_pendingは期限前の再接続を毎cron再kickし期限後のpath不在時だけ解除する', async () => {
    const database = await createStreamDatabase();
    await insertLive(database, { extendAt: '2026-09-01T02:01:00.000Z' });
    database.sqlite
      .query(
        "UPDATE stream_sessions SET status='ended', ended_at=?, end_reason='user_stop', kick_pending=1"
      )
      .run(NOW.toISOString());
    const media = new FakeMediaMtx([
      { name: 'live/AbCdEf123456', publisherId: 'publisher-1', rtspReaders: 0 },
    ]);
    await lifecycle(database, media);
    await lifecycle(database, media);
    expect(media.kicks).toEqual(['publisher-1', 'publisher-1']);
    expect(row(database).kick_pending).toBe(1);

    await lifecycle(database, new FakeMediaMtx(), new Date('2026-09-01T02:02:00.000Z'));
    expect(row(database).kick_pending).toBe(0);
  });

  it('期限後もreaderだけのpathが残る間はpath不在を確認できないためpendingを維持する', async () => {
    const database = await createStreamDatabase();
    await insertLive(database, { extendAt: '2026-09-01T01:59:00.000Z' });
    database.sqlite
      .query(
        "UPDATE stream_sessions SET status='ended', ended_at=?, end_reason='user_stop', kick_pending=1"
      )
      .run(NOW.toISOString());
    await lifecycle(
      database,
      new FakeMediaMtx([
        { name: 'live/AbCdEf123456', publisherId: null, rtspReaders: 1 },
      ])
    );
    expect(row(database).kick_pending).toBe(1);
  });

  it('ingress relay readerをviewerに数えず、egress RTSP readerだけで猶予を更新する', async () => {
    const database = await createStreamDatabase();
    await insertLive(database, {
      extendAt: '2026-09-01T04:00:00.000Z',
      viewerAt: '2026-09-01T01:50:00.000Z',
    });
    const ingress = new FakeMediaMtx([
      { name: 'live/AbCdEf123456', publisherId: 'relay', rtspReaders: 1 },
    ]);
    await runStreamLifecycle({
      database,
      ingressMediaMtx: ingress,
      egressMediaMtx: new FakeMediaMtx(),
      settings: SETTINGS,
      now: NOW,
    });
    expect(row(database)).toMatchObject({ status: 'ended', end_reason: 'no_viewers' });

    const second = await createStreamDatabase();
    await insertLive(second, {
      extendAt: '2026-09-01T04:00:00.000Z',
      viewerAt: '2026-09-01T01:50:00.000Z',
    });
    await runStreamLifecycle({
      database: second,
      ingressMediaMtx: ingress,
      egressMediaMtx: new FakeMediaMtx([
        { name: 'live/AbCdEf123456', publisherId: 'relay', rtspReaders: 1 },
      ]),
      settings: SETTINGS,
      now: NOW,
    });
    expect(row(second)).toMatchObject({ status: 'live', last_viewer_at: NOW.toISOString() });
  });

  it('replicaだけのRTSP readerも合計してviewer猶予を更新する', async () => {
    const database = await createStreamDatabase();
    await insertLive(database, {
      extendAt: '2026-09-01T04:00:00.000Z',
      viewerAt: '2026-09-01T01:50:00.000Z',
    });
    const summary = await runStreamLifecycle({
      database,
      ingressMediaMtx: new FakeMediaMtx(),
      egressMediaMtxs: [
        new FakeMediaMtx(),
        new FakeMediaMtx([{ name: 'live/AbCdEf123456', publisherId: null, rtspReaders: 1 }]),
      ],
      settings: SETTINGS,
      now: NOW,
    });

    expect(row(database)).toMatchObject({ status: 'live', last_viewer_at: NOW.toISOString() });
    expect(summary).toMatchObject({ viewersObserved: 1, egressObserved: 2, egressUnobserved: 0 });
  });

  it('read egressが未観測の回はno_viewersを発火せず件数を残す', async () => {
    const database = await createStreamDatabase();
    await insertLive(database, {
      extendAt: '2026-09-01T04:00:00.000Z',
      viewerAt: '2026-09-01T01:50:00.000Z',
    });
    const summary = await runStreamLifecycle({
      database,
      ingressMediaMtx: new FakeMediaMtx(),
      egressMediaMtxs: [new FakeMediaMtx(), new FakeMediaMtx([], new Error('replica unavailable'))],
      settings: SETTINGS,
      now: NOW,
    });

    expect(row(database)).toMatchObject({ status: 'live' });
    expect(summary).toMatchObject({ endedByNoViewers: 0, egressObserved: 1, egressUnobserved: 1 });
  });

  it('read egressが未観測でもextendとheartbeatのD1停止判定は続ける', async () => {
    const extendDatabase = await createStreamDatabase();
    await insertLive(extendDatabase, { extendAt: NOW.toISOString() });
    const heartbeatDatabase = await createStreamDatabase();
    await insertLive(heartbeatDatabase, {
      extendAt: '2026-09-01T04:00:00.000Z',
      heartbeatAt: '2026-09-01T01:59:00.000Z',
    });
    const input = (database: StreamSqliteAdapter) => ({
      database,
      ingressMediaMtx: new FakeMediaMtx(),
      egressMediaMtxs: [new FakeMediaMtx([], new Error('replica unavailable'))],
      settings: SETTINGS,
      now: NOW,
    });

    const [extendSummary, heartbeatSummary] = await Promise.all([
      runStreamLifecycle(input(extendDatabase)),
      runStreamLifecycle(input(heartbeatDatabase)),
    ]);

    expect(row(extendDatabase)).toMatchObject({ status: 'ended', end_reason: 'extend_timeout' });
    expect(extendSummary).toMatchObject({ endedByExtendTimeout: 1, egressUnobserved: 1 });
    expect(row(heartbeatDatabase)).toMatchObject({ status: 'ended', end_reason: 'heartbeat_lost' });
    expect(heartbeatSummary).toMatchObject({ endedByHeartbeatLost: 1, egressUnobserved: 1 });
  });

  it('ingressをkickした次のcronでegress path不在を確認してからpendingを解除する', async () => {
    const database = await createStreamDatabase();
    await insertLive(database, { extendAt: '2026-09-01T04:00:00.000Z' });
    database.sqlite
      .query("UPDATE stream_sessions SET status='ended', ended_at=?, end_reason='user_stop', kick_pending=1")
      .run(NOW.toISOString());
    const ingress = new FakeMediaMtx([
      {
        name: 'live/AbCdEf123456',
        publisherId: 'publisher-1',
        publisherSessionType: 'webRTCSession',
        rtspReaders: 0,
      },
    ]);
    await runStreamLifecycle({
      database,
      ingressMediaMtx: ingress,
      egressMediaMtx: new FakeMediaMtx(),
      settings: SETTINGS,
      now: NOW,
    });
    expect(ingress.kicks).toEqual(['publisher-1']);
    expect(row(database).kick_pending).toBe(1);

    await runStreamLifecycle({
      database,
      ingressMediaMtx: new FakeMediaMtx(),
      egressMediaMtx: new FakeMediaMtx(),
      settings: SETTINGS,
      now: NOW,
    });
    expect(row(database).kick_pending).toBe(0);
  });

  it('全read egressのどれかにpathが残る間はkick_pendingを解除しない', async () => {
    const database = await createStreamDatabase();
    await insertLive(database, { extendAt: '2026-09-01T04:00:00.000Z' });
    database.sqlite
      .query("UPDATE stream_sessions SET status='ended', ended_at=?, end_reason='user_stop', kick_pending=1")
      .run(NOW.toISOString());

    await runStreamLifecycle({
      database,
      ingressMediaMtx: new FakeMediaMtx(),
      egressMediaMtxs: [
        new FakeMediaMtx(),
        new FakeMediaMtx([{ name: 'live/AbCdEf123456', publisherId: null, rtspReaders: 1 }]),
      ],
      settings: SETTINGS,
      now: NOW,
    });

    expect(row(database).kick_pending).toBe(1);
  });

  it('閾値を30秒へ変更するとreaderゼロ30秒で終了する', async () => {
    const database = await createStreamDatabase();
    await insertLive(database, {
      extendAt: '2026-09-01T04:00:00.000Z',
      viewerAt: '2026-09-01T01:59:30.000Z',
    });
    await runStreamLifecycle({
      database,
      mediaMtx: new FakeMediaMtx(),
      settings: { ...SETTINGS, noViewerTimeoutSeconds: 30 },
      now: NOW,
    });
    expect(row(database)).toMatchObject({ status: 'ended', end_reason: 'no_viewers' });
  });
});
