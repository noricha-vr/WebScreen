import {
  runStreamLifecycle,
  type StreamLifecycleDatabase,
} from '../../src/lib/services/stream-lifecycle';
import { createStreamMediaMtxClients } from '../../src/lib/services/stream-media';

const SOURCE = 'webscreen-beta-cron';
const DEFAULT_NO_VIEWER_SECONDS = 10 * 60;
const DEFAULT_HEARTBEAT_SECONDS = 60;

export interface StreamCronEnv {
  DB: StreamLifecycleDatabase;
  /** 外部 MediaMTX が未構築の間は未設定可。対象行が無ければ安全に no-op。 */
  MEDIAMTX_API_URL?: string;
  /** secret。Control API の Bearer token。 */
  MEDIAMTX_API_TOKEN?: string;
  MEDIAMTX_INGRESS_API_URL?: string;
  MEDIAMTX_INGRESS_API_TOKEN?: string;
  MEDIAMTX_EGRESS_API_URL?: string;
  MEDIAMTX_EGRESS_API_TOKEN?: string;
  /** origin を含む全 read egress の Control API URL（カンマ区切り）。 */
  MEDIAMTX_READ_EGRESS_API_URLS?: string;
  STREAM_NO_VIEWER_SECONDS?: string;
  STREAM_HEARTBEAT_SECONDS?: string;
}

/** 配信セッションの毎分 lifecycle 判定を実行し、結果を構造化ログへ出す。 */
export async function runStreamCron(
  env: StreamCronEnv,
  scheduledTime: number,
  cron: string
): Promise<void> {
  const startedAt = Date.now();
  try {
    const mediaMtx = createStreamMediaMtxClients({
      legacyApiUrl: env.MEDIAMTX_API_URL,
      legacyApiToken: env.MEDIAMTX_API_TOKEN,
      ingressApiUrl: env.MEDIAMTX_INGRESS_API_URL,
      ingressApiToken: env.MEDIAMTX_INGRESS_API_TOKEN,
      egressApiUrl: env.MEDIAMTX_EGRESS_API_URL,
      egressApiToken: env.MEDIAMTX_EGRESS_API_TOKEN,
      readEgressApiUrls: env.MEDIAMTX_READ_EGRESS_API_URLS,
    });
    const summary = await runStreamLifecycle({
      database: env.DB,
      ingressMediaMtx: mediaMtx?.ingress,
      egressMediaMtx: mediaMtx?.egress,
      egressMediaMtxs: mediaMtx?.egresses,
      now: new Date(scheduledTime),
      settings: {
        noViewerTimeoutSeconds: positiveInt(
          env.STREAM_NO_VIEWER_SECONDS,
          DEFAULT_NO_VIEWER_SECONDS
        ),
        heartbeatTimeoutSeconds: positiveInt(
          env.STREAM_HEARTBEAT_SECONDS,
          DEFAULT_HEARTBEAT_SECONDS
        ),
      },
    });
    console.log(
      JSON.stringify({
        timestamp: new Date(scheduledTime).toISOString(),
        source: SOURCE,
        severity: 'info',
        kind: 'event',
        cron,
        event: 'stream_lifecycle_completed',
        summary,
        durationMs: Date.now() - startedAt,
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        timestamp: new Date(scheduledTime).toISOString(),
        source: SOURCE,
        severity: 'error',
        kind: 'event',
        cron,
        event: 'stream_lifecycle_failed',
        errorName: error instanceof Error ? error.name : 'UnknownError',
        summary: 'stream lifecycle run failed; D1 timeouts remain applied and viewer checks retry next run.',
        durationMs: Date.now() - startedAt,
      })
    );
    throw error;
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('Invalid stream cron setting');
  return parsed;
}
