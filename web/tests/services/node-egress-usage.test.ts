import { describe, expect, it } from 'bun:test';

import type { MediaMtxClient, MediaMtxPublisher } from '../../src/lib/infra/mediamtx';
import {
  recordNodeEgressUsage,
  type NodeEgressUsageDatabase,
  type NodeEgressUsageStatement,
} from '../../src/lib/services/node-egress-usage';

const NOW = new Date('2026-09-04T03:00:00.000Z');
const NODE = 'egress.example';

interface Sample {
  bytesSent: number | undefined;
  name?: string;
}

interface StoredDaily {
  bytesSent: number;
  alertedLevel: number;
}

/** node egress用の最小D1フェイク。SQLの結果状態だけを持ち、外部接続をしない。 */
class FakeNodeEgressDatabase implements NodeEgressUsageDatabase {
  readonly samples = new Map<string, number>();
  readonly daily = new Map<string, StoredDaily>();
  private failDailyBatchOnce = false;

  prepare(query: string) {
    return {
      bind: (...values: unknown[]): FakeNodeEgressStatement => ({
        query,
        values,
        all: async <T>(): Promise<{ results: T[] }> => ({ results: this.select(query, values) as T[] }),
        run: async (): Promise<{ meta: { changes: number } }> => ({
          meta: { changes: this.run(query, values) },
        }),
      }),
    };
  }

  /** 次のbatchの日次加算を失敗させ、途中変更がcommitされないことを検証する。 */
  failNextDailyBatch(): void {
    this.failDailyBatchOnce = true;
  }

  async batch(
    statements: NodeEgressUsageStatement[]
  ): Promise<Array<{ meta: { changes: number } }>> {
    const batchStatements = statements.map((statement) => {
      if (!isFakeNodeEgressStatement(statement)) throw new Error('Unknown test database statement');
      return statement;
    });
    const samples = new Map(this.samples);
    const daily = new Map([...this.daily].map(([key, row]) => [key, { ...row }]));
    const results = batchStatements.map((statement) => ({
      meta: { changes: this.run(statement.query, statement.values, samples, daily, true) },
    }));
    this.samples.clear();
    this.daily.clear();
    samples.forEach((value, key) => this.samples.set(key, value));
    daily.forEach((value, key) => this.daily.set(key, value));
    return results;
  }

  private select(query: string, values: unknown[]): unknown[] {
    if (query.includes('FROM node_egress_samples')) {
      const nodeKey = values[0] as string;
      return [...this.samples.entries()]
        .filter(([key]) => key.startsWith(`${nodeKey}\u0000`))
        .map(([key, bytesSent]) => ({ path: key.split('\u0000')[1], bytes_sent: bytesSent }));
    }
    if (query.includes('FROM node_egress_daily')) {
      const row = this.daily.get(dailyKey(values[0] as string, values[1] as string));
      return row === undefined
        ? []
        : [{ bytes_sent: row.bytesSent, alerted_level: row.alertedLevel }];
    }
    return [];
  }

  private run(
    query: string,
    values: unknown[],
    samples: Map<string, number> = this.samples,
    daily: Map<string, StoredDaily> = this.daily,
    inBatch: boolean = false
  ): number {
    if (query.includes('INSERT INTO node_egress_samples')) {
      samples.set(sampleKey(values[0] as string, values[1] as string), values[2] as number);
      return 1;
    }
    if (query.includes('DELETE FROM node_egress_samples')) {
      return samples.delete(sampleKey(values[0] as string, values[1] as string)) ? 1 : 0;
    }
    if (query.includes('INSERT INTO node_egress_daily')) {
      const key = dailyKey(values[0] as string, values[1] as string);
      if (inBatch && this.failDailyBatchOnce) {
        this.failDailyBatchOnce = false;
        throw new Error('daily write failed');
      }
      const existing = daily.get(key);
      const bytesSent = values[2] as number;
      const nodeKey = values[5] as string;
      const path = values[6] as string;
      const previous = samples.get(sampleKey(nodeKey, path));
      const bytesAdded = previous === undefined || bytesSent < previous ? bytesSent : bytesSent - previous;
      daily.set(key, {
        bytesSent: (existing?.bytesSent ?? 0) + bytesAdded,
        alertedLevel: existing?.alertedLevel ?? 0,
      });
      return 1;
    }
    if (query.includes('UPDATE node_egress_daily SET alerted_level')) {
      const level = values[0] as number;
      const key = dailyKey(values[1] as string, values[2] as string);
      const row = daily.get(key);
      if (row === undefined) return 0;
      if (query.includes('alerted_level <') && row.alertedLevel >= (values[3] as number)) {
        return 0;
      }
      if (query.includes('AND alerted_level = ?') && row.alertedLevel !== (values[3] as number)) {
        return 0;
      }
      row.alertedLevel = level;
      return 1;
    }
    return 0;
  }
}

interface FakeNodeEgressStatement extends NodeEgressUsageStatement {
  query: string;
  values: unknown[];
}

function isFakeNodeEgressStatement(
  statement: NodeEgressUsageStatement
): statement is FakeNodeEgressStatement {
  return 'query' in statement && 'values' in statement;
}

function sampleKey(nodeKey: string, path: string): string {
  return `${nodeKey}\u0000${path}`;
}

function dailyKey(nodeKey: string, day: string): string {
  return `${nodeKey}\u0000${day}`;
}

function pathName(index: number): string {
  return `live/AbCdEf12345${index}`;
}

function client(samples: Sample[] | Error): MediaMtxClient {
  return {
    getPath: async () => undefined,
    listPaths: async () => {
      if (samples instanceof Error) throw samples;
      return samples.map((sample, index) => ({
        name: sample.name ?? pathName(index),
        publisherId: null,
        rtspReaders: 0,
        bytesSent: sample.bytesSent,
      }));
    },
    kickPublisher: async (_publisher: MediaMtxPublisher) => undefined,
  };
}

async function record(
  database: FakeNodeEgressDatabase,
  paths: Sample[] | Error,
  options: { limit?: number; notify?: (message: string) => Promise<boolean> } = {}
) {
  return recordNodeEgressUsage({
    database,
    nodes: [{ nodeKey: NODE, client: client(paths) }],
    now: NOW,
    dailyLimitBytes: options.limit ?? 1_000,
    notify: options.notify ?? (async () => true),
  });
}

describe('node egress usage', () => {
  it('初回サンプルは累積値を日次使用量へ加算する', async () => {
    const database = new FakeNodeEgressDatabase();

    const summary = await record(database, [{ bytesSent: 120 }]);

    expect(summary).toEqual({
      nodesSampled: 1,
      nodesFailed: 0,
      bytesAdded: 120,
      alertsSent: 0,
      pathsSkipped: 0,
    });
    expect(database.daily.get(dailyKey(NODE, '2026-09-04'))?.bytesSent).toBe(120);
  });

  it('増分だけを加算する', async () => {
    const database = new FakeNodeEgressDatabase();
    await record(database, [{ bytesSent: 120 }]);

    await record(database, [{ bytesSent: 175 }]);

    expect(database.daily.get(dailyKey(NODE, '2026-09-04'))?.bytesSent).toBe(175);
  });

  it('並行する2実行でも同じ増分を二重加算しない', async () => {
    const database = new FakeNodeEgressDatabase();

    await Promise.all([
      record(database, [{ bytesSent: 120 }]),
      record(database, [{ bytesSent: 120 }]),
    ]);

    expect(database.daily.get(dailyKey(NODE, '2026-09-04'))?.bytesSent).toBe(120);
    expect(database.samples.get(sampleKey(NODE, pathName(0)))).toBe(120);
  });

  it('カウンタが戻ったpathは再起動後の累積値を加算する', async () => {
    const database = new FakeNodeEgressDatabase();
    await record(database, [{ bytesSent: 120 }]);

    await record(database, [{ bytesSent: 20 }]);

    expect(database.daily.get(dailyKey(NODE, '2026-09-04'))?.bytesSent).toBe(140);
  });

  it('消えたpathのサンプルを削除する', async () => {
    const database = new FakeNodeEgressDatabase();
    await record(database, [{ bytesSent: 120 }]);

    await record(database, []);

    expect(database.samples.has(sampleKey(NODE, pathName(0)))).toBe(false);
  });

  it('70%を一度だけ送り、85%到達で次の通知を送る', async () => {
    const database = new FakeNodeEgressDatabase();
    const messages: string[] = [];
    const notify = async (message: string): Promise<boolean> => {
      messages.push(message);
      return true;
    };
    await record(database, [{ bytesSent: 700 }], { notify });

    await record(database, [{ bytesSent: 700 }], { notify });
    await record(database, [{ bytesSent: 850 }], { notify });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain(NODE);
    expect(messages[0]).toContain('70.0%');
    expect(messages[1]).toContain('85.0%');
    expect(database.daily.get(dailyKey(NODE, '2026-09-04'))?.alertedLevel).toBe(85);
  });

  it('1ノードの取得失敗を隔離して他ノードの集計を続ける', async () => {
    const database = new FakeNodeEgressDatabase();
    const failed = client(new Error('unavailable'));
    const healthy = client([{ bytesSent: 40 }]);
    const original = console.error;
    console.error = () => {};
    try {
      const summary = await recordNodeEgressUsage({
        database,
        nodes: [
          { nodeKey: 'failed.example', client: failed },
          { nodeKey: NODE, client: healthy },
        ],
        now: NOW,
        dailyLimitBytes: 1_000,
        notify: async () => true,
      });
      expect(summary).toEqual({
        nodesSampled: 1,
        nodesFailed: 1,
        bytesAdded: 40,
        alertsSent: 0,
        pathsSkipped: 0,
      });
    } finally {
      console.error = original;
    }
  });

  it('通知に失敗したらalerted levelを戻して次回に再送する', async () => {
    const database = new FakeNodeEgressDatabase();
    let calls = 0;
    const original = console.warn;
    console.warn = () => {};
    try {
      await record(database, [{ bytesSent: 700 }], {
        notify: async () => {
          calls += 1;
          return false;
        },
      });
      await record(database, [{ bytesSent: 700 }], {
        notify: async () => {
          calls += 1;
          return false;
        },
      });
    } finally {
      console.warn = original;
    }

    expect(calls).toBe(2);
    expect(database.daily.get(dailyKey(NODE, '2026-09-04'))?.alertedLevel).toBe(0);
  });

  it('無効なpath名またはsafe integerでないカウンタを集計から除外する', async () => {
    const database = new FakeNodeEgressDatabase();
    const original = console.warn;
    console.warn = () => {};
    try {
      const summary = await record(database, [
        { name: 'other/path', bytesSent: 40 },
        { bytesSent: Number.MAX_SAFE_INTEGER + 1 },
      ]);
      expect(summary).toEqual({
        nodesSampled: 1,
        nodesFailed: 0,
        bytesAdded: 0,
        alertsSent: 0,
        pathsSkipped: 2,
      });
    } finally {
      console.warn = original;
    }
  });

  it('無効なcounterが一時的に返っても既存sampleを保持する', async () => {
    const database = new FakeNodeEgressDatabase();
    const original = console.warn;
    console.warn = () => {};
    try {
      await record(database, [{ bytesSent: 120 }]);
      await record(database, [{ bytesSent: undefined }]);
      await record(database, [{ bytesSent: 175 }]);
    } finally {
      console.warn = original;
    }

    expect(database.daily.get(dailyKey(NODE, '2026-09-04'))?.bytesSent).toBe(175);
    expect(database.samples.get(sampleKey(NODE, pathName(0)))).toBe(175);
  });

  it('batch途中の日次加算失敗ではsample更新もcommitしない', async () => {
    const database = new FakeNodeEgressDatabase();
    database.failNextDailyBatch();

    await expect(record(database, [{ bytesSent: 120 }])).rejects.toThrow('daily write failed');

    expect(database.samples.size).toBe(0);
    expect(database.daily.size).toBe(0);
  });
});
