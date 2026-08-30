import { describe, expect, it } from 'bun:test';

import worker from '../../cron/src/index';
import type {
  RetentionBucket,
  RetentionDatabase,
} from '../../src/lib/services/retention';
import type { CaptureListResult } from '../../src/lib/services/retention-captures';

const SCHEDULED_TIME = Date.parse('2026-08-25T12:00:00.000Z');

/**
 * 掃除対象は無く、監査のサンプルだけを返す D1 のフェイク。
 *
 * cron の入口が summary へ件数を載せるかだけを見たいので、掃除側の SELECT は
 * すべて空で返し、監査のサンプル抽出だけが行を返す形にする。
 */
class FakeCronDatabase implements RetentionDatabase {
  constructor(private readonly readyRows: string[] = []) {}

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        all: async <T>(): Promise<{ results: T[] }> => ({
          results: this.select(query, values) as T[],
        }),
        run: async (): Promise<{ meta: { changes: number } }> => ({ meta: { changes: 0 } }),
      }),
    };
  }

  private select(query: string, values: unknown[]): { short_id: string }[] {
    // 監査のサンプル抽出（開始点以降を LIMIT 件。0 件なら監査側が先頭から引き直す）。
    if (query.includes('short_id >= ?')) {
      return this.readyRows
        .filter((shortId) => shortId >= (values[0] as string))
        .map((shortId) => ({ short_id: shortId }));
    }
    // 監査の再確認（行がまだ ready で残っているか）。
    if (query.includes('WHERE short_id = ?') && query.includes("status = 'ready'")) {
      return this.readyRows
        .filter((shortId) => shortId === (values[0] as string))
        .map((shortId) => ({ short_id: shortId }));
    }
    return [];
  }
}

/** 実体を 1 つも持たない R2 のフェイク（監査が「実体なし」を見つける）。 */
class FakeCronBucket implements RetentionBucket {
  constructor(private readonly failHead = false) {}

  async head(): Promise<{ size: number } | null> {
    if (this.failHead) throw new Error('R2 unavailable');
    return null;
  }

  async delete(): Promise<void> {}

  async list(): Promise<CaptureListResult> {
    return { objects: [], truncated: false };
  }
}

interface CronLogEntry {
  severity: string;
  summary: string;
  detail: {
    missingObjectRows: number;
    checkedReadyRows: number;
    skippedRows: number;
    auditErrors: number;
  };
}

/** scheduled() が出した 1 行 JSON を、出力先（log / warn / error）と一緒に取る。 */
async function runScheduled(
  database: RetentionDatabase,
  bucket: RetentionBucket = new FakeCronBucket()
): Promise<{ level: 'log' | 'warn' | 'error'; entry: CronLogEntry }> {
  const original = { log: console.log, warn: console.warn, error: console.error };
  let captured: { level: 'log' | 'warn' | 'error'; entry: CronLogEntry } | undefined;
  const capture =
    (level: 'log' | 'warn' | 'error') =>
    (line: string): void => {
      captured = { level, entry: JSON.parse(line) as CronLogEntry };
    };
  console.log = capture('log') as typeof console.log;
  console.warn = capture('warn') as typeof console.warn;
  console.error = capture('error') as typeof console.error;

  try {
    await worker.scheduled(
      { scheduledTime: SCHEDULED_TIME, cron: '0 * * * *' },
      { DB: database, BUCKET: bucket }
    );
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }

  if (!captured) throw new Error('cron が 1 行も記録しなかった');
  return captured;
}

describe('保持期間バッチの cron ログ', () => {
  it('実体の無い ready 行を検出したら件数を summary に出し、error で記録する', async () => {
    const { level, entry } = await runScheduled(new FakeCronDatabase(['strandedAAAA']));

    expect(level).toBe('error');
    expect(entry.severity).toBe('error');
    expect(entry.summary).toContain('audited 1 ready rows (1 missing objects)');
    expect(entry.detail.missingObjectRows).toBe(1);
  });

  it('監査の head が失敗したら warn で記録し、実体なしとは数えない', async () => {
    const { level, entry } = await runScheduled(
      new FakeCronDatabase(['unreachableA']),
      new FakeCronBucket(true)
    );

    expect(level).toBe('warn');
    expect(entry.detail.auditErrors).toBe(1);
    expect(entry.detail.missingObjectRows).toBe(0);
    expect(entry.summary).toContain('1 audit checks failed');
  });

  it('不整合が無ければ info で、確認した件数だけを summary に出す', async () => {
    const { level, entry } = await runScheduled(new FakeCronDatabase());

    expect(level).toBe('log');
    expect(entry.severity).toBe('info');
    expect(entry.summary).toContain('audited 0 ready rows (0 missing objects)');
    expect(entry.summary).not.toContain('rows skipped');
    expect(entry.detail.skippedRows).toBe(0);
  });
});
