import { ERROR_CODES } from '../contracts/api';
import { logWorkerFailure } from '../observability/worker-log';

/** presign の想定外失敗を機密値なしで構造化ログへ記録する。 */
export function logPresignInternalFailure(): void {
  logWorkerFailure({
    event: 'upload_presign_failed',
    errorCode: ERROR_CODES.internalError,
    status: 500,
  });
}
