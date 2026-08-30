import { describe, expect, test } from 'bun:test';

import {
  CRON_REALERT_INTERVAL_MS,
  CRON_STALE_THRESHOLD_MS,
  buildAlertMessage,
  createCronHealthReader,
  decideCronAlert,
  evaluateFreshness,
  readRetentionFreshness,
  recordCronRun,
  RETENTION_ALERT_NAME,
  RETENTION_RUN_NAME,
  runRetentionAlert,
  type CronRunDatabase,
} from '../../src/lib/services/cron-health';

const NOW = new Date('2026-08-31T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

interface StoredRow {
  last_success_at: string;
  last_summary: string | null;
}

/** cron_runs だけを持つ D1 のフェイク（UPSERT は Map の上書きで再現する）。 */
class FakeCronDatabase implements CronRunDatabase {
  readonly rows = new Map<string, StoredRow>();

  constructor(rows: Record<string, StoredRow> = {}) {
    for (const [name, row] of Object.entries(rows)) this.rows.set(name, row);
  }

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        all: async <T>(): Promise<{ results: T[] }> => {
          const row = this.rows.get(values[0] as string);
          return { results: row === undefined ? [] : ([row] as T[]) };
        },
        run: async (): Promise<{ meta: { changes: number } }> => {
          if (!query.includes('INSERT INTO cron_runs')) throw new Error(`unexpected: ${query}`);
          this.rows.set(values[0] as string, {
            last_success_at: values[1] as string,
            last_summary: values[2] as string | null,
          });
          return { meta: { changes: 1 } };
        },
      }),
    };
  }
}

/** 送った本文を控える通知先。delivered=false で送信失敗を再現する。 */
function fakeNotifier(delivered = true): {
  notify: (message: string) => Promise<boolean>;
  messages: string[];
} {
  const messages: string[] = [];
  return {
    messages,
    notify: async (message) => {
      messages.push(message);
      return delivered;
    },
  };
}

describe('recordCronRun', () => {
  test('成功した実行の時刻と件数を残し、次の実行で上書きする', async () => {
    const database = new FakeCronDatabase();

    await recordCronRun({
      database,
      name: RETENTION_RUN_NAME,
      at: NOW,
      summary: { deletedMovies: 3, deletedCaptures: 7 },
    });
    await recordCronRun({
      database,
      name: RETENTION_RUN_NAME,
      at: new Date(NOW.getTime() + HOUR_MS),
      summary: { deletedMovies: 0, deletedCaptures: 1 },
    });

    const row = database.rows.get(RETENTION_RUN_NAME);
    expect(row?.last_success_at).toBe('2026-08-31T13:00:00.000Z');
    expect(JSON.parse(row?.last_summary ?? '{}')).toEqual({ deletedMovies: 0, deletedCaptures: 1 });
    expect(database.rows.size).toBe(1);
  });
});

describe('evaluateFreshness', () => {
  test('直前に成功していれば stale ではなく、経過秒を返す', () => {
    const result = evaluateFreshness(NOW, '2026-08-31T11:43:00.000Z');
    expect(result).toEqual({
      lastSuccessAt: '2026-08-31T11:43:00.000Z',
      ageSeconds: 17 * 60,
      stale: false,
    });
  });

  test('1 回の不発火（閾値内）では stale にしない', () => {
    const lastSuccess = new Date(NOW.getTime() - CRON_STALE_THRESHOLD_MS + 60_000);
    expect(evaluateFreshness(NOW, lastSuccess.toISOString()).stale).toBe(false);
  });

  test('閾値を超えたら stale', () => {
    const lastSuccess = new Date(NOW.getTime() - CRON_STALE_THRESHOLD_MS - 60_000);
    expect(evaluateFreshness(NOW, lastSuccess.toISOString()).stale).toBe(true);
  });

  test('記録が無ければ stale（監視が動き出す前を正常扱いにしない）', () => {
    expect(evaluateFreshness(NOW, null)).toEqual({
      lastSuccessAt: null,
      ageSeconds: null,
      stale: true,
    });
  });

  test('読めない値も stale にする', () => {
    expect(evaluateFreshness(NOW, 'not-a-timestamp').stale).toBe(true);
  });

  test('SQLite の datetime 形式（Z 無し）も UTC として解釈する', () => {
    // ローカル時刻として解釈されると、JST の手元では 9 時間ずれて stale 判定が変わる。
    expect(evaluateFreshness(NOW, '2026-08-31 11:43:00')).toEqual({
      lastSuccessAt: '2026-08-31T11:43:00.000Z',
      ageSeconds: 17 * 60,
      stale: false,
    });
  });
});

describe('decideCronAlert', () => {
  const alerting = (agoMs: number) =>
    ({ at: new Date(NOW.getTime() - agoMs), state: 'alerting' }) as const;

  test('停止していて未通知なら通知する', () => {
    expect(decideCronAlert({ now: NOW, stale: true, lastAlert: null })).toBe('alert');
  });

  test('通知済みで再送間隔の内側なら黙る', () => {
    const lastAlert = alerting(CRON_REALERT_INTERVAL_MS - 60_000);
    expect(decideCronAlert({ now: NOW, stale: true, lastAlert })).toBe('none');
  });

  test('再送間隔を過ぎたら再通知する', () => {
    const lastAlert = alerting(CRON_REALERT_INTERVAL_MS + 60_000);
    expect(decideCronAlert({ now: NOW, stale: true, lastAlert })).toBe('alert');
  });

  test('正常に戻ったら回復を通知する', () => {
    expect(decideCronAlert({ now: NOW, stale: false, lastAlert: alerting(HOUR_MS) })).toBe(
      'recovered'
    );
  });

  test('回復を通知した後の正常時は何もしない', () => {
    const lastAlert = { at: new Date(NOW.getTime() - HOUR_MS), state: 'recovered' } as const;
    expect(decideCronAlert({ now: NOW, stale: false, lastAlert })).toBe('none');
  });

  test('一度も通知していない正常時は何もしない', () => {
    expect(decideCronAlert({ now: NOW, stale: false, lastAlert: null })).toBe('none');
  });
});

describe('buildAlertMessage', () => {
  test('停止の通知に最終成功と経過時間を載せる', () => {
    const message = buildAlertMessage({
      decision: 'alert',
      freshness: { lastSuccessAt: '2026-08-31T08:17:00.000Z', ageSeconds: 3 * 3600 + 43 * 60, stale: true },
    });
    expect(message).toContain('[警告]');
    expect(message).toContain('2026-08-31T08:17:00.000Z');
    expect(message).toContain('3 時間 43 分前');
  });

  test('記録が無い時は経過時間を数値で書かない', () => {
    const message = buildAlertMessage({
      decision: 'alert',
      freshness: { lastSuccessAt: null, ageSeconds: null, stale: true },
    });
    expect(message).toContain('記録なし');
    expect(message).not.toContain('NaN');
  });

  test('回復の通知は警告と区別できる', () => {
    const message = buildAlertMessage({
      decision: 'recovered',
      freshness: { lastSuccessAt: '2026-08-31T11:47:00.000Z', ageSeconds: 13 * 60, stale: false },
    });
    expect(message).toContain('[回復]');
    expect(message).toContain('13 分前');
  });
});

describe('runRetentionAlert', () => {
  const staleRow = {
    last_success_at: new Date(NOW.getTime() - 3 * HOUR_MS).toISOString(),
    last_summary: '{}',
  };
  const freshRow = {
    last_success_at: new Date(NOW.getTime() - 13 * 60_000).toISOString(),
    last_summary: '{}',
  };

  test('2 回連続で発火していなければ 1 回通知し、通知済みとして記録する', async () => {
    const database = new FakeCronDatabase({ [RETENTION_RUN_NAME]: staleRow });
    const notifier = fakeNotifier();

    const result = await runRetentionAlert({ database, now: NOW, notify: notifier.notify });

    expect(result.decision).toBe('alert');
    expect(notifier.messages).toHaveLength(1);
    expect(notifier.messages[0]).toContain('[警告]');
    expect(database.rows.get(RETENTION_ALERT_NAME)).toEqual({
      last_success_at: NOW.toISOString(),
      last_summary: '{"state":"alerting"}',
    });
  });

  test('同じ停止状態のまま再送間隔の内側なら送らない', async () => {
    const database = new FakeCronDatabase({
      [RETENTION_RUN_NAME]: staleRow,
      [RETENTION_ALERT_NAME]: {
        last_success_at: new Date(NOW.getTime() - HOUR_MS).toISOString(),
        last_summary: '{"state":"alerting"}',
      },
    });
    const notifier = fakeNotifier();

    const result = await runRetentionAlert({ database, now: NOW, notify: notifier.notify });

    expect(result.decision).toBe('none');
    expect(notifier.messages).toHaveLength(0);
  });

  test('回復したら 1 回だけ回復を通知する', async () => {
    const database = new FakeCronDatabase({
      [RETENTION_RUN_NAME]: freshRow,
      [RETENTION_ALERT_NAME]: {
        last_success_at: new Date(NOW.getTime() - HOUR_MS).toISOString(),
        last_summary: '{"state":"alerting"}',
      },
    });
    const notifier = fakeNotifier();

    const first = await runRetentionAlert({ database, now: NOW, notify: notifier.notify });
    const second = await runRetentionAlert({
      database,
      now: new Date(NOW.getTime() + HOUR_MS),
      notify: notifier.notify,
    });

    expect(first.decision).toBe('recovered');
    expect(second.decision).toBe('none');
    expect(notifier.messages).toHaveLength(1);
    expect(notifier.messages[0]).toContain('[回復]');
  });

  test('送信に失敗したら通知済みにせず、次の実行で送り直す', async () => {
    const database = new FakeCronDatabase({ [RETENTION_RUN_NAME]: staleRow });
    const failing = fakeNotifier(false);

    const first = await runRetentionAlert({ database, now: NOW, notify: failing.notify });
    expect(first.notifyFailed).toBe(true);
    expect(database.rows.has(RETENTION_ALERT_NAME)).toBe(false);

    const succeeding = fakeNotifier();
    const second = await runRetentionAlert({
      database,
      now: new Date(NOW.getTime() + HOUR_MS),
      notify: succeeding.notify,
    });
    expect(second.decision).toBe('alert');
    expect(succeeding.messages).toHaveLength(1);
  });

  test('実行記録がまったく無ければ停止として通知する', async () => {
    const database = new FakeCronDatabase();
    const notifier = fakeNotifier();

    const result = await runRetentionAlert({ database, now: NOW, notify: notifier.notify });

    expect(result.decision).toBe('alert');
    expect(result.freshness.stale).toBe(true);
    expect(notifier.messages[0]).toContain('記録なし');
  });
});

describe('createCronHealthReader', () => {
  /** D1 が落ちている状況（prepare の時点で失敗する）。 */
  const brokenDatabase: CronRunDatabase = {
    prepare() {
      throw new Error('D1 unavailable');
    },
  };

  /** worker-log が出す 1 行 JSON を捨てつつ件数だけ数える。 */
  async function countFailureLogs(run: () => Promise<void>): Promise<number> {
    const original = console.error;
    let count = 0;
    console.error = () => {
      count += 1;
    };
    try {
      await run();
    } finally {
      console.error = original;
    }
    return count;
  }

  test('D1 が失敗しても例外にせず error セクションを返し、失敗を記録する', async () => {
    const read = createCronHealthReader(0);
    let section: unknown;

    const logs = await countFailureLogs(async () => {
      section = await read(brokenDatabase, NOW);
    });

    expect(section).toEqual({ error: true });
    expect(logs).toBe(1);
  });

  test('DB binding が無い時も error セクションを返す（設定漏れを静かに流さない）', async () => {
    const read = createCronHealthReader(0);
    let section: unknown;

    const logs = await countFailureLogs(async () => {
      section = await read(undefined, NOW);
    });

    expect(section).toEqual({ error: true });
    expect(logs).toBe(1);
  });

  test('TTL の内側は D1 を読み直さない（無認証の経路で read を増やさない）', async () => {
    let reads = 0;
    const database: CronRunDatabase = {
      prepare: () => ({
        bind: () => ({
          all: async <T>(): Promise<{ results: T[] }> => {
            reads += 1;
            return {
              results: [
                { last_success_at: new Date(NOW.getTime() - 60_000).toISOString(), last_summary: null },
              ] as T[],
            };
          },
          run: async () => ({ meta: { changes: 0 } }),
        }),
      }),
    };
    const read = createCronHealthReader(60_000);

    await read(database, NOW);
    await read(database, new Date(NOW.getTime() + 30_000));
    expect(reads).toBe(1);

    await read(database, new Date(NOW.getTime() + 61_000));
    expect(reads).toBe(2);
  });
});

describe('readRetentionFreshness', () => {
  test('記録した直後の実行は stale ではない', async () => {
    const database = new FakeCronDatabase();
    await recordCronRun({
      database,
      name: RETENTION_RUN_NAME,
      at: new Date(NOW.getTime() - 13 * 60_000),
      summary: { deletedMovies: 1 },
    });

    const freshness = await readRetentionFreshness(database, NOW);

    expect(freshness.stale).toBe(false);
    expect(freshness.ageSeconds).toBe(13 * 60);
    expect(freshness.lastSuccessAt).toBe('2026-08-31T11:47:00.000Z');
  });
});
