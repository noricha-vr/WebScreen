import type { ErrorCode } from '../contracts/api';
import type { QuotaDatabase } from './quota';

/** D1 の更新まで含む、アップロードサービスが必要とする最小の操作面。 */
export interface UploadDatabase extends QuotaDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}

/** API ハンドラが HTTP 応答へ変換するドメインエラー。 */
export class UploadError extends Error {
  constructor(
    public readonly status: 400 | 404 | 413 | 429,
    public readonly errorCode: ErrorCode,
    message: string
  ) {
    super(message);
  }
}
