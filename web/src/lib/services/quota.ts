/** ユーザーごとの動画保存容量上限（500 MiB）。 */
export const USER_STORAGE_QUOTA_BYTES = 524_288_000;

/** ユーザーごとの pin 上限。pin API 実装時にもこの定数を使用する。 */
export const MAX_PINNED_MOVIES = 10;

/** D1 の最小操作面。サービスを workerd の実装から切り離す。 */
export interface QuotaDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
    };
  };
}

interface UsageRow {
  total: number | null;
}

/** pending と ready の movies を合計し、ユーザーの予約済み使用量を返す。 */
export async function getUserStorageUsage(
  database: QuotaDatabase,
  userId: number
): Promise<number> {
  const row = await database
    .prepare(
      "SELECT COALESCE(SUM(size_bytes), 0) AS total FROM movies WHERE user_id = ? AND status IN ('pending', 'ready')"
    )
    .bind(userId)
    .first<UsageRow>();

  return row?.total ?? 0;
}

/** 既存使用量に追加サイズを加えて保存容量を超えるか判定する。 */
export function exceedsStorageQuota(usedBytes: number, additionalBytes: number): boolean {
  return usedBytes + additionalBytes > USER_STORAGE_QUOTA_BYTES;
}
