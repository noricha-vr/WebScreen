import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';

import type { MediaMtxClient } from '../../src/lib/infra/mediamtx';
import {
  recordNodeEgressUsage,
  type NodeEgressUsageDatabase,
  type NodeEgressUsageStatement,
} from '../../src/lib/services/node-egress-usage';

/**
 * 実 SQLite（bun:sqlite）で SQL をそのまま実行するテスト。
 * フェイク D1 は差分ロジックを再実装しているため、CASE / LEFT JOIN / ON CONFLICT の
 * 正しさはここでしか検証できない。
 */

const MIGRATION = readFileSync(
  new URL('../../migrations/0005_node_egress_usage.sql', import.meta.url),
  'utf8'
);
const NODE = 'egress.example';
const PATH = 'live/AbCdEf123456';
const LIMIT = 1_000;

interface SqliteStatement extends NodeEgressUsageStatement {
  query: string;
  values: unknown[];
}

function createSqliteDatabase(): NodeEgressUsageDatabase & { db: Database } {
  const db = new Database(':memory:');
  db.exec(MIGRATION);
  const params = (values: unknown[]) => values as Array<string | number | null>;
  const statement = (query: string, values: unknown[]): SqliteStatement => ({
    query,
    values,
    all: async <T>() => ({ results: db.query(query).all(...params(values)) as T[] }),
    run: async () => ({ meta: { changes: db.prepare(query).run(...params(values)).changes } }),
  });
  return {
    db,
    prepare(query: string) {
      return { bind: (...values: unknown[]) => statement(query, values) };
    },
    async batch(statements) {
      const run = db.transaction(() =>
        statements.map((item) => {
          const own = item as SqliteStatement;
          return { meta: { changes: db.prepare(own.query).run(...params(own.values)).changes } };
        })
      );
      return run();
    },
  };
}

function client(paths: Array<{ name: string; bytesSent: number | undefined }>): MediaMtxClient {
  return {
    listPaths: async () =>
      paths.map((path) => ({ ...path, publisherId: null, rtspReaders: 0 })),
    getPath: async () => undefined,
    kickPublisher: async () => undefined,
  } as MediaMtxClient;
}

async function record(
  database: NodeEgressUsageDatabase,
  paths: Array<{ name: string; bytesSent: number | undefined }>,
  now: Date,
  notify: (message: string) => Promise<boolean> = async () => true
) {
  return recordNodeEgressUsage({
    database,
    nodes: [{ nodeKey: NODE, client: client(paths) }],
    now,
    dailyLimitBytes: LIMIT,
    notify,
  });
}

function daily(db: Database): { bytes_sent: number; alerted_level: number } | null {
  return db
    .query('SELECT bytes_sent, alerted_level FROM node_egress_daily WHERE node_key = ?')
    .get(NODE) as { bytes_sent: number; alerted_level: number } | null;
}

function sample(db: Database, path = PATH): number | null {
  const row = db
    .query('SELECT bytes_sent FROM node_egress_samples WHERE node_key = ? AND path = ?')
    .get(NODE, path) as { bytes_sent: number } | null;
  return row?.bytes_sent ?? null;
}

const T0 = new Date('2026-09-04T03:00:00.000Z');
const T1 = new Date('2026-09-04T03:01:00.000Z');
const T2 = new Date('2026-09-04T03:02:00.000Z');

describe('node egress usage on real SQLite', () => {
  it('初回は生涯値を、以降は差分を加算し、カウンタが下がったら再起動として全量を足す', async () => {
    const database = createSqliteDatabase();
    await record(database, [{ name: PATH, bytesSent: 100 }], T0);
    await record(database, [{ name: PATH, bytesSent: 150 }], T1);
    expect(daily(database.db)?.bytes_sent).toBe(150);
    await record(database, [{ name: PATH, bytesSent: 30 }], T2);
    expect(daily(database.db)?.bytes_sent).toBe(180);
    expect(sample(database.db)).toBe(30);
  });

  it('counter が無効な回は baseline を保持し、消えた path の sample は削除する', async () => {
    const database = createSqliteDatabase();
    await record(database, [{ name: PATH, bytesSent: 120 }], T0);
    const skipped = await record(database, [{ name: PATH, bytesSent: undefined }], T1);
    expect(skipped.pathsSkipped).toBe(1);
    expect(sample(database.db)).toBe(120);
    await record(database, [{ name: PATH, bytesSent: 175 }], T2);
    expect(daily(database.db)?.bytes_sent).toBe(175);
    await record(database, [], new Date('2026-09-04T03:03:00.000Z'));
    expect(sample(database.db)).toBeNull();
  });

  it('古い観測が後から届いても再起動と誤認せず、sample も巻き戻さない', async () => {
    const database = createSqliteDatabase();
    await record(database, [{ name: PATH, bytesSent: 100 }], T0);
    await record(database, [{ name: PATH, bytesSent: 175 }], T2);
    await record(database, [{ name: PATH, bytesSent: 120 }], T1);
    expect(daily(database.db)?.bytes_sent).toBe(175);
    expect(sample(database.db)).toBe(175);
  });

  it('1 ノードの listPaths 失敗は他ノードの集計を止めず、不正な path 名は除外する', async () => {
    const database = createSqliteDatabase();
    const broken: MediaMtxClient = {
      ...client([]),
      listPaths: async () => {
        throw new Error('unreachable');
      },
    };
    const summary = await recordNodeEgressUsage({
      database,
      nodes: [
        { nodeKey: 'broken.example', client: broken },
        { nodeKey: NODE, client: client([{ name: PATH, bytesSent: 40 }, { name: 'live/../etc', bytesSent: 9 }]) },
      ],
      now: T0,
      dailyLimitBytes: LIMIT,
      notify: async () => true,
    });
    expect(summary).toEqual({
      nodesSampled: 1,
      nodesFailed: 1,
      bytesAdded: 40,
      alertsSent: 0,
      pathsSkipped: 1,
    });
    expect(daily(database.db)?.bytes_sent).toBe(40);
  });

  it('閾値は到達時の最高レベルを 1 回だけ通知し、送信失敗なら次回に再送する', async () => {
    const database = createSqliteDatabase();
    const sent: string[] = [];
    let deliver = false;
    const notify = async (message: string) => {
      if (deliver) sent.push(message);
      return deliver;
    };
    await record(database, [{ name: PATH, bytesSent: 750 }], T0, notify);
    expect(sent).toHaveLength(0);
    expect(daily(database.db)?.alerted_level).toBe(0);
    deliver = true;
    await record(database, [{ name: PATH, bytesSent: 750 }], T1, notify);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('75.0%');
    await record(database, [{ name: PATH, bytesSent: 760 }], T2, notify);
    expect(sent).toHaveLength(1);
    await record(database, [{ name: PATH, bytesSent: 960 }], new Date('2026-09-04T03:03:00.000Z'), notify);
    expect(sent).toHaveLength(2);
    expect(daily(database.db)?.alerted_level).toBe(95);
  });
});
