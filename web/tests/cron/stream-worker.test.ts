import { describe, expect, it } from 'bun:test';

import worker from '../../cron/src/index';

describe('配信 lifecycle cron の振り分け', () => {
  it('毎分式をretentionへfallbackせず、対象0件ならMediaMTX未設定でもno-opにする', async () => {
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

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ event: 'stream_lifecycle_completed', severity: 'info' });
    expect(logs[0]?.['summary']).toMatchObject({ deletedStartCancellations: 0 });
  });
});
