/**
 * 実 SQLite（bun:sqlite）で動かすテストへ、本番と同じ migration を同じ順で当てる。
 *
 * 0001 だけを読むと、後から足した列（movies.kind）やテーブル（usage_events）が無い状態で
 * サービスを動かすことになり、本番では通る INSERT がテストでだけ落ちる（またはその逆）。
 */

import { readdirSync } from 'node:fs';
import type { Database } from 'bun:sqlite';

const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);

export async function applyMigrations(sqlite: Database): Promise<void> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of files) {
    sqlite.exec(await Bun.file(new URL(name, MIGRATIONS_DIR)).text());
  }
}
