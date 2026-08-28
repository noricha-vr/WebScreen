import type { ErrorCode } from '../contracts/api';

const SOURCE = 'webscreen-beta-worker';

type WorkerLogLevel = 'warn' | 'error';
const WORKER_FAILURE_EVENTS = [
  'oauth_upstream_request_failed',
  'oauth_callback_failed',
  'movie_pin_failed',
  'movie_rename_failed',
  'movie_delete_failed',
  'upload_presign_failed',
  'upload_commit_failed',
  'capture_request_json_invalid',
  'capture_upstream_response_invalid',
  'capture_worker_timeout',
  'capture_upstream_request_failed',
  'capture_upstream_rejected',
  'capture_upstream_error_unmapped',
] as const;
type WorkerFailureEvent = (typeof WORKER_FAILURE_EVENTS)[number];

/** Worker がクライアントへ返す失敗を、安全な識別子だけで 1 行 JSON として記録する。 */
export function logWorkerFailure({
  level = 'error',
  event,
  errorCode,
  status,
  upstreamStatus,
}: {
  level?: WorkerLogLevel;
  event: WorkerFailureEvent;
  errorCode: ErrorCode;
  status: number;
  upstreamStatus?: number;
}): void {
  // URL・Cookie・上流本文は含めず、Cloudflare observability で安全に絞り込める項目だけを出す。
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    source: SOURCE,
    severity: level,
    kind: 'event',
    level,
    event,
    errorCode,
    status,
    upstreamStatus,
    summary: `${event} returned ${status} ${errorCode}.`,
  });
  if (level === 'warn') {
    console.warn(entry);
    return;
  }
  console.error(entry);
}
