import { Database, type SQLQueryBindings } from 'bun:sqlite';

import type { StreamLifecycleDatabase } from '../../../src/lib/services/stream-lifecycle';
import type { StreamDatabase } from '../../../src/lib/services/streams';

interface SqliteStatementDetails {
  query: string;
  values: unknown[];
}

/** bun:sqlite を stream service / lifecycle の D1 境界へ合わせる。 */
export class StreamSqliteAdapter implements StreamDatabase, StreamLifecycleDatabase {
  private readonly statementDetails = new WeakMap<object, SqliteStatementDetails>();

  constructor(readonly sqlite: Database) {}

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => {
        const statement = {
          first: async <T>(): Promise<T | null> =>
            (this.sqlite.query(query).get(...(values as SQLQueryBindings[])) as T | null) ?? null,
          all: async <T>(): Promise<{ results: T[] }> => ({
            results: this.sqlite.query(query).all(...(values as SQLQueryBindings[])) as T[],
          }),
          run: async (): Promise<{ meta: { changes: number } }> =>
            this.runStatement(query, values),
        };
        this.statementDetails.set(statement, { query, values });
        return statement;
      },
    };
  }

  async batch(
    statements: Parameters<StreamDatabase['batch']>[0]
  ): Promise<Array<{ meta: { changes: number } }>> {
    const execute = this.sqlite.transaction(() =>
      statements.map((statement) => {
        const details = this.statementDetails.get(statement);
        if (!details) throw new Error('Unknown test database statement');
        return this.runStatement(details.query, details.values);
      })
    );
    return execute();
  }

  private runStatement(query: string, values: unknown[]): { meta: { changes: number } } {
    const result = this.sqlite.query(query).run(...(values as SQLQueryBindings[]));
    return { meta: { changes: result.changes } };
  }
}

/** 実 migration 0001 + 0003 + 0004 を適用したテスト用 DB を作る。 */
export async function createStreamDatabase(): Promise<StreamSqliteAdapter> {
  const sqlite = new Database(':memory:');
  sqlite.exec(await Bun.file(new URL('../../../migrations/0001_init.sql', import.meta.url)).text());
  sqlite.exec(
    await Bun.file(new URL('../../../migrations/0003_stream_sessions.sql', import.meta.url)).text()
  );
  sqlite.exec(
    await Bun.file(new URL('../../../migrations/0004_stream_start_cancellations.sql', import.meta.url)).text()
  );
  sqlite
    .query('INSERT INTO users (id, discord_id, name) VALUES (?, ?, ?), (?, ?, ?)')
    .run(10, '10', 'owner', 20, '20', 'other');
  return new StreamSqliteAdapter(sqlite);
}
