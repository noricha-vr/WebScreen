import { describe, expect, it } from 'bun:test';

import type { MediaMtxClient, MediaMtxPublisher } from '../../src/lib/infra/mediamtx';
import {
  recordNodeEgressUsage,
  type NodeEgressUsageDatabase,
} from '../../src/lib/services/node-egress-usage';

const NOW = new Date('2026-09-04T03:00:00.000Z');
const NODE = 'egress.example';

interface Sample {
  bytesSent: number;
}

interface StoredDaily {
  bytesSent: number;
  alertedLevel: number;
}

/** node egress用の最小D1フェイク。SQLの結果状態だけを持ち、外部接続をしない。 */
class FakeNodeEgressDatabase implements NodeEgressUsageDatabase {
  readonly samples = new Map<string, number>();
  readonly daily = new Map<string, StoredDaily>();

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        all: async <T>(): Promise<{ results: T[] }> => ({
          results: this.select(query, values) as T[],
        }),
        run: async (): Promise<{ meta: { changes: number } }> => ({
          meta: { changes: this.run(query, values) },
        }),
      }),
    };
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

  private run(query: string, values: unknown[]): number {
    if (query.includes('INSERT INTO node_egress_samples')) {
      this.samples.set(sampleKey(values[0] as string, values[1] as string), values[2] as number);
      return 1;
    }
    if (query.includes('DELETE FROM node_egress_samples')) {
      return this.samples.delete(sampleKey(values[0] as string, values[1] as string)) ? 1 : 0;
    }
    if (query.includes('INSERT INTO node_egress_daily')) {
      const key = dailyKey(values[0] as string, values[1] as string);
      const existing = this.daily.get(key);
      const bytesAdded = values[2] as number;
      this.daily.set(key, {
        bytesSent: (existing?.bytesSent ?? 0) + bytesAdded,
        alertedLevel: existing?.alertedLevel ?? 0,
      });
      return 1;
    }
    if (query.includes('UPDATE node_egress_daily SET alerted_level')) {
      const level = values[0] as number;
      const key = dailyKey(values[1] as string, values[2] as string);
      const row = this.daily.get(key);
      if (row === undefined || row.alertedLevel >= (values[3] as number)) return 0;
      row.alertedLevel = level;
      return 1;
    }
    return 0;
  }
}

function sampleKey(nodeKey: string, path: string): string {
  return `${nodeKey}\u0000${path}`;
}

function dailyKey(nodeKey: string, day: string): string {
  return `${nodeKey}\u0000${day}`;
}

function client(samples: Sample[] | Error): MediaMtxClient {
  return {
    getPath: async () => undefined,
    listPaths: async () => {
      if (samples instanceof Error) throw samples;
      return samples.map((sample, index) => ({
        name: `live/path${index}`,
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

    expect(summary).toEqual({ nodesSampled: 1, nodesFailed: 0, bytesAdded: 120, alertsSent: 0 });
    expect(database.daily.get(dailyKey(NODE, '2026-09-04'))?.bytesSent).toBe(120);
  });

  it('増分だけを加算する', async () => {
    const database = new FakeNodeEgressDatabase();
    await record(database, [{ bytesSent: 120 }]);

    await record(database, [{ bytesSent: 175 }]);

    expect(database.daily.get(dailyKey(NODE, '2026-09-04'))?.bytesSent).toBe(175);
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

    expect(database.samples.has(sampleKey(NODE, 'live/path0'))).toBe(false);
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
      expect(summary).toEqual({ nodesSampled: 1, nodesFailed: 1, bytesAdded: 40, alertsSent: 0 });
    } finally {
      console.error = original;
    }
  });

  it('通知に失敗してもalerted levelを戻さず再通知しない', async () => {
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

    expect(calls).toBe(1);
    expect(database.daily.get(dailyKey(NODE, '2026-09-04'))?.alertedLevel).toBe(70);
  });
});
