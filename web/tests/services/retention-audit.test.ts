import { describe, expect, it } from 'bun:test';

import { movieKey } from '../../src/lib/contracts/r2key';
import {
  auditReadyObjects,
  MAX_OBJECT_CHECKS_PER_RUN,
  type AuditBucket,
  type AuditDatabase,
} from '../../src/lib/services/retention-audit';

interface TestRow {
  shortId: string;
  status: 'pending' | 'ready' | 'failed';
}

/** 監査が投げる 2 文（ready のサンプル抽出と 1 行の再確認）だけを持つフェイク。 */
class FakeAuditDatabase implements AuditDatabase {
  private readonly rows: TestRow[];

  constructor(rows: TestRow[]) {
    this.rows = rows.map((row) => ({ ...row }));
  }

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        all: async <T>(): Promise<{ results: T[] }> => ({
          results: this.select(query, values) as T[],
        }),
      }),
    };
  }

  /** 行を消す（所有者の削除が割り込んだ状況の再現）。 */
  removeRow(shortId: string): void {
    const index = this.rows.findIndex((row) => row.shortId === shortId);
    if (index >= 0) this.rows.splice(index, 1);
  }

  private select(query: string, values: unknown[]): { short_id: string }[] {
    const ready = this.rows.filter((row) => row.status === 'ready');
    if (query.includes('ORDER BY RANDOM()')) {
      return ready.slice(0, values[0] as number).map((row) => ({ short_id: row.shortId }));
    }
    return ready
      .filter((row) => row.shortId === (values[0] as string))
      .map((row) => ({ short_id: row.shortId }));
  }
}

class FakeAuditBucket implements AuditBucket {
  readonly checkedKeys: string[] = [];
  /** head が例外を投げるキー（R2 の一時失敗の再現）。 */
  readonly failingKeys = new Set<string>();

  constructor(
    private readonly objects: Set<string>,
    private readonly onHead?: (key: string) => void
  ) {}

  async head(key: string): Promise<{ size: number } | null> {
    this.checkedKeys.push(key);
    if (this.failingKeys.has(key)) throw new Error('R2 unavailable');
    this.onHead?.(key);
    return this.objects.has(key) ? { size: 1 } : null;
  }
}

function readyRow(shortId: string): TestRow {
  return { shortId, status: 'ready' };
}

describe('auditReadyObjects', () => {
  it('実体の無い ready 行を数える（削除はしない）', async () => {
    const database = new FakeAuditDatabase([readyRow('strandedAAAA'), readyRow('healthyAAAAA')]);
    const bucket = new FakeAuditBucket(new Set([movieKey('healthyAAAAA')]));

    const audit = await auditReadyObjects(database, bucket);

    expect(audit).toEqual({ checkedReadyRows: 2, missingObjectRows: 1, skippedRows: 0 });
    // 検出だけを行う。行が残っていることは次の実行でも同じ結果になることで確かめる。
    expect(await auditReadyObjects(database, bucket)).toMatchObject({ missingObjectRows: 1 });
  });

  it('所有者の削除の途中（R2 だけ消えた瞬間）は不整合に数えない', async () => {
    const database = new FakeAuditDatabase([readyRow('deletingAAAA')]);
    // head の後に行が消える = deleteMovie が R2 → D1 の順で進んでいる最中。
    const bucket = new FakeAuditBucket(new Set(), () => database.removeRow('deletingAAAA'));

    const audit = await auditReadyObjects(database, bucket);

    expect(audit).toEqual({ checkedReadyRows: 1, missingObjectRows: 0, skippedRows: 0 });
  });

  it('R2 の一時失敗は実体なしと読まず、skipped として次回に委ねる', async () => {
    const database = new FakeAuditDatabase([readyRow('unreachableA'), readyRow('healthyAAAAA')]);
    const bucket = new FakeAuditBucket(new Set([movieKey('healthyAAAAA')]));
    bucket.failingKeys.add(movieKey('unreachableA'));

    const audit = await auditReadyObjects(database, bucket);

    expect(audit).toEqual({ checkedReadyRows: 1, missingObjectRows: 0, skippedRows: 1 });
  });

  it('1 回の実行で確認する行数は上限で打ち切る', async () => {
    const rows = Array.from({ length: MAX_OBJECT_CHECKS_PER_RUN + 5 }, (_, index) =>
      readyRow(`sample${String(index).padStart(6, '0')}`)
    );
    const database = new FakeAuditDatabase(rows);
    const bucket = new FakeAuditBucket(new Set(rows.map((row) => movieKey(row.shortId))));

    const audit = await auditReadyObjects(database, bucket);

    expect(audit.checkedReadyRows).toBe(MAX_OBJECT_CHECKS_PER_RUN);
    expect(bucket.checkedKeys).toHaveLength(MAX_OBJECT_CHECKS_PER_RUN);
  });

  it('ready 以外の行は見ない（pending と failed は掃除の担当）', async () => {
    const database = new FakeAuditDatabase([
      { shortId: 'pendingAAAAA', status: 'pending' },
      { shortId: 'failedAAAAAA', status: 'failed' },
    ]);
    const bucket = new FakeAuditBucket(new Set());

    const audit = await auditReadyObjects(database, bucket);

    expect(audit).toEqual({ checkedReadyRows: 0, missingObjectRows: 0, skippedRows: 0 });
    expect(bucket.checkedKeys).toEqual([]);
  });
});
