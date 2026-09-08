import { describe, expect, test } from 'bun:test';

import { USAGE_EVENTS, recordUsageEvent, type UsageLogDatabase } from '../../src/lib/services/usage-log';

class FakeUsageLogDatabase implements UsageLogDatabase {
  readonly queries: string[] = [];
  readonly bound: unknown[][] = [];

  constructor(private readonly failing = false) {}

  prepare(query: string) {
    this.queries.push(query);
    return {
      bind: (...values: unknown[]) => ({
        run: async () => {
          if (this.failing) throw new Error('D1 unavailable');
          this.bound.push(values);
          return { meta: { changes: 1 } };
        },
      }),
    };
  }
}

/** warn の 1 行 JSON を集める。 */
async function captureWarnLogs<T>(run: () => Promise<T>): Promise<{ result: T; entries: string[] }> {
  const original = console.warn;
  const entries: string[] = [];
  console.warn = (entry: unknown) => {
    entries.push(String(entry));
  };
  try {
    return { result: await run(), entries };
  } finally {
    console.warn = original;
  }
}

describe('利用ログ', () => {
  test('migration 0006 の CHECK 制約と同じ出来事だけを持つ', () => {
    expect(USAGE_EVENTS).toEqual([
      'login',
      'movie_ready',
      'movie_deleted',
      'movie_expired',
      'movie_pinned',
      'movie_unpinned',
    ]);
  });

  test('動画の出来事は short_id・種別・サイズを添えて 1 行追記する', async () => {
    const database = new FakeUsageLogDatabase();

    const written = await recordUsageEvent(database, {
      userId: 7,
      event: 'movie_ready',
      shortId: 'Ab12Cd34Ef56',
      kind: 'pdf',
      sizeBytes: 1024,
    });

    expect(written).toBe(true);
    expect(database.queries).toEqual([
      'INSERT INTO usage_events (user_id, event, short_id, kind, size_bytes) VALUES (?, ?, ?, ?, ?)',
    ]);
    expect(database.bound).toEqual([[7, 'movie_ready', 'Ab12Cd34Ef56', 'pdf', 1024]]);
  });

  test('login は動画の列を null で埋める（undefined を D1 に渡さない）', async () => {
    const database = new FakeUsageLogDatabase();

    await recordUsageEvent(database, { userId: 7, event: 'login' });

    expect(database.bound).toEqual([[7, 'login', null, null, null]]);
  });

  test('書けなくても例外を投げず、warn の構造化ログに残して false を返す', async () => {
    const database = new FakeUsageLogDatabase(true);

    const { result, entries } = await captureWarnLogs(() =>
      recordUsageEvent(database, { userId: 7, event: 'login' })
    );

    expect(result).toBe(false);
    expect(entries).toHaveLength(1);
    const entry = JSON.parse(entries[0]) as Record<string, unknown>;
    expect(entry.event).toBe('usage_event_write_failed');
    expect(entry.severity).toBe('warn');
    expect(entry.errorName).toBe('Error');
    // 例外本文は載せない。
    expect(entries[0]).not.toContain('D1 unavailable');
  });
});
