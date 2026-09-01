/** ユーザーごとの動画保存容量上限（500 MiB）。 */
export const USER_STORAGE_QUOTA_BYTES = 524_288_000;

/**
 * ユーザーごとに同時に予約できる pending アップロード数。
 * 正常な変換の並行利用は妨げず、署名URLを大量に確保して容量と回収キューを占有する乱用を抑える。
 */
export const MAX_PENDING_UPLOADS_PER_USER = 10;

/** ユーザーごとの pin 上限。pin API 実装時にもこの定数を使用する。 */
export const MAX_PINNED_MOVIES = 10;

/** pin していない動画の保管期間（30 日）。presign 時の期限設定と pin 解除時の復元で共有する。 */
export const MOVIE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * pin した動画の保管期間（365 日）。期限を持たせないと退会・放置された動画が
 * 永久に R2 の容量を占め続けるため、通常より長い上限を置く形にする。
 */
export const PINNED_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * pin 解除時、元の保管期限が既に過ぎていた場合に与える猶予（7 日）。
 * 解除した瞬間に削除対象へ落ちると、ユーザーが取り違えに気づく機会が無くなるため。
 */
export const UNPIN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

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

interface UploadQuotaRow extends UsageRow {
  pending_count: number | null;
}

/**
 * pending・ready・failed の movies を合計し、ユーザーの予約済み使用量を返す。
 *
 * TTL 5 分 + retention 間隔で最大約 66 分の R2 残置を許容する。
 * 500 MiB 計上だと中止で 24 時間ロックアウトするため、failed も size_bytes を使う。
 */
export async function getUserStorageUsage(
  database: QuotaDatabase,
  userId: number
): Promise<number> {
  const row = await database
    .prepare(
      "SELECT COALESCE(SUM(size_bytes), 0) AS total FROM movies WHERE user_id = ? AND status IN ('pending', 'ready', 'failed')"
    )
    .bind(userId)
    .first<UsageRow>();

  return row?.total ?? 0;
}

/** pending 作成に失敗した後、容量と予約件数のどちらが上限かを判定する。 */
export async function getUserUploadQuota(
  database: QuotaDatabase,
  userId: number
): Promise<{ usedBytes: number; pendingUploads: number }> {
  const row = await database
    .prepare(
      "SELECT COALESCE(SUM(size_bytes), 0) AS total, COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count FROM movies WHERE user_id = ? AND status IN ('pending', 'ready', 'failed')"
    )
    .bind(userId)
    .first<UploadQuotaRow>();

  return { usedBytes: row?.total ?? 0, pendingUploads: row?.pending_count ?? 0 };
}

/** 既存使用量に追加サイズを加えて保存容量を超えるか判定する。 */
export function exceedsStorageQuota(usedBytes: number, additionalBytes: number): boolean {
  return usedBytes + additionalBytes > USER_STORAGE_QUOTA_BYTES;
}
