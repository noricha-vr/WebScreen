import { describe, expect, it } from 'bun:test';

import worker from '../../cron/src/index';

describe('配信 lifecycle cron の振り分け', () => {
  it('毎分式をretentionへfallbackせず、対象0件なら監視設定の既定値でno-opにする', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const original = console.log;
    console.log = (line: unknown) => logs.push(JSON.parse(String(line)) as Record<string, unknown>);
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
      console.log = original;
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
    expect(logs.find((entry) => entry['event'] === 'node_egress_usage_completed')).toMatchObject({
      event: 'node_egress_usage_completed',
      severity: 'info',
      summary: { nodesSampled: 0, nodesFailed: 0, bytesAdded: 0, alertsSent: 0 },
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
        { DB: database, NODE_EGRESS_DAILY_LIMIT_BYTES: 'invalid' } as never
      );
    } finally {
      console.log = originals.log;
      console.error = originals.error;
    }

    expect(logs.some((entry) => entry['event'] === 'stream_lifecycle_completed')).toBe(true);
    expect(logs.some((entry) => entry['event'] === 'node_egress_usage_failed')).toBe(true);
  });
});
