import type { ErrorCode } from '../contracts/api';
import type { ClientErrorCode, ClientErrorStage } from '../contracts/client-error';

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
  'upload_commit_oversize_claim_missed',
  'upload_commit_oversize_object_delete_failed',
  'movie_delete_row_stranded',
  'preview_owner_check_failed',
  'capture_request_json_invalid',
  'capture_upstream_response_invalid',
  'capture_worker_timeout',
  'capture_upstream_request_failed',
  'capture_upstream_rejected',
  'capture_upstream_error_unmapped',
  'health_cron_read_failed',
] as const;
type WorkerFailureEvent = (typeof WORKER_FAILURE_EVENTS)[number];

/** Worker がクライアントへ返す失敗を、安全な識別子だけで 1 行 JSON として記録する。 */
export function logWorkerFailure({
  level = 'error',
  event,
  errorCode,
  status,
  upstreamStatus,
  errorName,
}: {
  level?: WorkerLogLevel;
  event: WorkerFailureEvent;
  errorCode: ErrorCode;
  status: number;
  upstreamStatus?: number;
  /** 例外の種別だけ（`error.name`）。message / stack は内容が読めないので入れない。 */
  errorName?: string;
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
    errorName,
    summary: `${event} returned ${status} ${errorCode}.`,
  });
  if (level === 'warn') {
    console.warn(entry);
    return;
  }
  console.error(entry);
}

/**
 * ブラウザ内で完結した失敗（撮影・変換・アップロードなど）を 1 行 JSON として記録する。
 *
 * 出すのは検証済みの識別子だけ。URL・Cookie・User-Agent・本文は含めない
 * （報告者は無認証のクライアントなので、通した値はそのままログに焼き付く）。
 * level を warn にするのは Worker 自身の失敗ではないため。混ぜると Worker の
 * エラー率が読めなくなる。
 */
export function logClientError({
  stage,
  errorCode,
  httpStatus,
  userId,
}: {
  stage: ClientErrorStage;
  errorCode: ClientErrorCode;
  httpStatus?: number;
  userId?: number;
}): void {
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      source: SOURCE,
      severity: 'warn',
      kind: 'event',
      level: 'warn',
      event: 'client_error',
      stage,
      errorCode,
      httpStatus,
      userId,
      summary: `client reported ${errorCode} at ${stage}.`,
    })
  );
}

/**
 * 失敗報告のレート制限 binding が無いまま動いていることを知らせる。
 *
 * 制限なしで通す判断（テレメトリのために報告者を 500 にしない）とセットで、
 * 本番で binding が外れていても気づけるようにするための 1 行。
 */
export function logClientErrorLimiterMissing(): void {
  console.warn(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      source: SOURCE,
      severity: 'warn',
      kind: 'event',
      level: 'warn',
      event: 'client_error_limiter_missing',
      summary: 'CLIENT_ERROR_LIMITER binding is missing; accepting reports without a limit.',
    })
  );
}
