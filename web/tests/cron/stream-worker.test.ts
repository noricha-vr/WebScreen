import { describe, expect, it } from 'bun:test';

import worker from '../../cron/src/index';

describe('配信 lifecycle cron の振り分け', () => {
  it('毎分式をretentionへfallbackせず、対象0件なら監視設定の既定値でno-opにする', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const originals = { log: console.log, warn: console.warn };
    console.log = (line: unknown) => logs.push(JSON.parse(String(line)) as Record<string, unknown>);
    console.warn = (line: unknown) => logs.push(JSON.parse(String(line)) as Record<string, unknown>);
    const database = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        }),
      }),
    };
    try {
      await worker.scheduled(
        { scheduledTime: Date.parse('2026-09-01T02:00:00.000Z'), cron: '* * * * *' },
        { DB: database } as never
      );
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
    }

    expect(logs.find((entry) => entry['event'] === 'stream_lifecycle_completed')).toMatchObject({
      event: 'stream_lifecycle_completed',
      severity: 'info',
    });
    expect(logs.find((entry) => entry['event'] === 'stream_lifecycle_completed')?.['summary']).toMatchObject({
      deletedStartCancellations: 0,
      egressObserved: 0,
      egressUnobserved: 0,
    });
    expect(logs.find((entry) => entry['event'] === 'node_egress_usage_skipped')).toMatchObject({
      event: 'node_egress_usage_skipped',
      severity: 'warn',
    });
  });

  it('監視設定が壊れてもlifecycle結果を失わせない', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const originals = { log: console.log, error: console.error };
    console.log = (line: unknown) => logs.push(JSON.parse(String(line)) as Record<string, unknown>);
    console.error = (line: unknown) => logs.push(JSON.parse(String(line)) as Record<string, unknown>);
    const database = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        }),
      }),
    };
    try {
      await worker.scheduled(
        { scheduledTime: Date.parse('2026-09-01T02:00:00.000Z'), cron: '* * * * *' },
        {
          DB: database,
          MEDIAMTX_INGRESS_API_URL: 'https://ingress.example',
          MEDIAMTX_INGRESS_API_TOKEN: 'token',
          MEDIAMTX_EGRESS_API_URL: 'https://egress.example',
          MEDIAMTX_EGRESS_API_TOKEN: 'token',
          NODE_EGRESS_DAILY_LIMIT_BYTES: 'invalid',
        } as never
      );
    } finally {
      console.log = originals.log;
      console.error = originals.error;
    }

    expect(logs.some((entry) => entry['event'] === 'stream_lifecycle_completed')).toBe(true);
    expect(logs.some((entry) => entry['event'] === 'node_egress_usage_failed')).toBe(true);
  });

  it('MediaMTX client設定が壊れたら両処理をskipしてcronを失敗にする', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const original = console.error;
    console.error = (line: unknown) => logs.push(JSON.parse(String(line)) as Record<string, unknown>);
    const database = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        }),
      }),
    };
    try {
      await expect(
        worker.scheduled(
          { scheduledTime: Date.parse('2026-09-01T02:00:00.000Z'), cron: '* * * * *' },
          { DB: database, MEDIAMTX_INGRESS_API_URL: 'https://ingress.example' } as never
        )
      ).rejects.toThrow('MediaMTX INGRESS API URL and token are both required');
    } finally {
      console.error = original;
    }

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'stream_mediamtx_config_failed', severity: 'error' });
  });
});
