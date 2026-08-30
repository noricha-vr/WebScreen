import { describe, expect, test } from 'bun:test';

import worker from '../../cron/src/index';
import {
  RETENTION_ALERT_NAME,
  RETENTION_RUN_NAME,
  type CronRunDatabase,
} from '../../src/lib/services/cron-health';

const SCHEDULED_TIME = Date.parse('2026-08-31T12:47:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const ALERT_CRON = '47 * * * *';
const WEBHOOK_URL = 'https://discord.example/api/webhooks/1/token-placeholder';

interface StoredRow {
  last_success_at: string;
  last_summary: string | null;
}

/** cron_runs だけを持つ D1 のフェイク（監視 cron は他のテーブルを触らない）。 */
class FakeCronRunsDatabase implements CronRunDatabase {
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

interface ScheduledRun {
  logs: { level: 'log' | 'warn' | 'error'; entry: { severity: string; summary: string } }[];
  posts: { url: string; content: string }[];
}

/**
 * scheduled() を叩き、出た構造化ログと webhook への POST を取る。
 *
 * fetch を差し替えるのはプロセス外境界（Discord）なので、実ネットワークは使わない。
 */
async function runScheduled(
  cron: string,
  database: CronRunDatabase,
  env: { webhookUrl?: string } = { webhookUrl: WEBHOOK_URL }
): Promise<ScheduledRun> {
  const logs: ScheduledRun['logs'] = [];
  const posts: ScheduledRun['posts'] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const originalFetch = globalThis.fetch;

  console.log = (entry: unknown) => logs.push({ level: 'log', entry: JSON.parse(String(entry)) });
  console.warn = (entry: unknown) => logs.push({ level: 'warn', entry: JSON.parse(String(entry)) });
  console.error = (entry: unknown) =>
    logs.push({ level: 'error', entry: JSON.parse(String(entry)) });
  globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
    posts.push({ url: String(url), content: JSON.parse(String(init?.body)).content });
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;

  try {
    await worker.scheduled({ scheduledTime: SCHEDULED_TIME, cron }, {
      DB: database,
      BUCKET: {} as never,
      DISCORD_ALERT_WEBHOOK_URL: env.webhookUrl,
    } as never);
  } finally {
    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    globalThis.fetch = originalFetch;
  }

  return { logs, posts };
}

describe('監視 cron（47 分）', () => {
  test('2 回連続で発火していなければ Discord へ 1 回通知する', async () => {
    const database = new FakeCronRunsDatabase({
      [RETENTION_RUN_NAME]: {
        last_success_at: new Date(SCHEDULED_TIME - 3 * HOUR_MS).toISOString(),
        last_summary: '{}',
      },
    });

    const run = await runScheduled(ALERT_CRON, database);

    expect(run.posts).toHaveLength(1);
    expect(run.posts[0]!.url).toBe(WEBHOOK_URL);
    expect(run.posts[0]!.content).toContain('[警告]');
    expect(run.logs[0]!.level).toBe('warn');
    expect(database.rows.get(RETENTION_ALERT_NAME)?.last_summary).toBe('{"state":"alerting"}');
  });

  test('停止したまま連投防止で黙る回も warn で残す（info だと正常に見える）', async () => {
    const database = new FakeCronRunsDatabase({
      [RETENTION_RUN_NAME]: {
        last_success_at: new Date(SCHEDULED_TIME - 3 * HOUR_MS).toISOString(),
        last_summary: '{}',
      },
      [RETENTION_ALERT_NAME]: {
        last_success_at: new Date(SCHEDULED_TIME - HOUR_MS).toISOString(),
        last_summary: '{"state":"alerting"}',
      },
    });

    const run = await runScheduled(ALERT_CRON, database);

    expect(run.posts).toHaveLength(0);
    expect(run.logs[0]!.level).toBe('warn');
  });

  test('直前に成功していれば通知せず info を残す', async () => {
    const database = new FakeCronRunsDatabase({
      [RETENTION_RUN_NAME]: {
        last_success_at: new Date(SCHEDULED_TIME - 30 * 60_000).toISOString(),
        last_summary: '{}',
      },
    });

    const run = await runScheduled(ALERT_CRON, database);

    expect(run.posts).toHaveLength(0);
    expect(run.logs[0]!.level).toBe('log');
    expect(run.logs[0]!.entry.severity).toBe('info');
  });

  test('通知先が未設定なら送信せず、通知済みにもしない', async () => {
    const database = new FakeCronRunsDatabase({
      [RETENTION_RUN_NAME]: {
        last_success_at: new Date(SCHEDULED_TIME - 3 * HOUR_MS).toISOString(),
        last_summary: '{}',
      },
    });

    const run = await runScheduled(ALERT_CRON, database, { webhookUrl: undefined });

    expect(run.posts).toHaveLength(0);
    expect(run.logs.some((entry) => entry.entry.summary.includes('DISCORD_ALERT_WEBHOOK_URL'))).toBe(
      true
    );
    // 送れていないので記録も残さない（次の実行で送り直せる）。
    expect(database.rows.has(RETENTION_ALERT_NAME)).toBe(false);
    expect(run.logs.some((entry) => entry.level === 'error')).toBe(true);
  });
});

describe('未知の cron 式', () => {
  test('どちらのハンドラも呼ばず error を残す', async () => {
    const database = new FakeCronRunsDatabase();

    const run = await runScheduled('0 3 * * *', database);

    expect(run.posts).toHaveLength(0);
    expect(database.rows.size).toBe(0);
    expect(run.logs[0]!.level).toBe('error');
    expect(run.logs[0]!.entry.summary).toContain('No handler is registered');
  });
});
