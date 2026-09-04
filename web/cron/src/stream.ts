import {
  runStreamLifecycle,
  type StreamLifecycleDatabase,
} from '../../src/lib/services/stream-lifecycle';
import {
  createStreamMediaMtxClients,
  type StreamMediaMtxClients,
} from '../../src/lib/services/stream-media';
import { createDiscordNotifier } from '../../src/lib/services/cron-health';
import {
  recordNodeEgressUsage,
  type NodeEgressUsageDatabase,
} from '../../src/lib/services/node-egress-usage';

const SOURCE = 'webscreen-beta-cron';
const DEFAULT_NO_VIEWER_SECONDS = 10 * 60;
const DEFAULT_HEARTBEAT_SECONDS = 60;
const DEFAULT_NODE_EGRESS_DAILY_LIMIT_BYTES = 160_000_000_000;

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
  /** secret。Node egress上限通知用の Discord Incoming Webhook URL。 */
  DISCORD_ALERT_WEBHOOK_URL?: string;
  /** 1 read egress nodeの日次転送量上限（bytes）。 */
  NODE_EGRESS_DAILY_LIMIT_BYTES?: string;
}

/** 配信セッションの毎分 lifecycle 判定を実行し、結果を構造化ログへ出す。 */
export async function runStreamCron(
  env: StreamCronEnv,
  scheduledTime: number,
  cron: string
): Promise<void> {
  const startedAt = Date.now();
  const timestamp = new Date(scheduledTime).toISOString();
  let mediaMtx: StreamMediaMtxClients | undefined;
  try {
    mediaMtx = createStreamMediaMtxClients({
      legacyApiUrl: env.MEDIAMTX_API_URL,
      legacyApiToken: env.MEDIAMTX_API_TOKEN,
      ingressApiUrl: env.MEDIAMTX_INGRESS_API_URL,
      ingressApiToken: env.MEDIAMTX_INGRESS_API_TOKEN,
      egressApiUrl: env.MEDIAMTX_EGRESS_API_URL,
      egressApiToken: env.MEDIAMTX_EGRESS_API_TOKEN,
      readEgressApiUrls: env.MEDIAMTX_READ_EGRESS_API_URLS,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        timestamp,
        source: SOURCE,
        severity: 'error',
        kind: 'event',
        cron,
        event: 'stream_mediamtx_config_failed',
        errorName: error instanceof Error ? error.name : 'UnknownError',
        summary: 'MediaMTX client configuration failed; lifecycle and node egress usage were skipped.',
        durationMs: Date.now() - startedAt,
      })
    );
    throw error;
  }
  let lifecycleFailure: unknown;

  try {
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
    lifecycleFailure = error;
    console.error(
      JSON.stringify({
        timestamp,
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
  }

  // lifecycle の失敗を再送出する前に独立して実行する。監視の障害もここで止め、
  // lifecycle の成功・失敗を監視の付帯処理で書き換えない。
  if (mediaMtx === undefined || mediaMtx.readNodes.length === 0) {
    console.warn(
      JSON.stringify({
        timestamp,
        source: SOURCE,
        severity: 'warn',
        kind: 'event',
        cron,
        event: 'node_egress_usage_skipped',
        summary: 'No read egress nodes are configured; node egress usage was skipped.',
        durationMs: Date.now() - startedAt,
      })
    );
  } else {
    try {
      const dailyLimitBytes = positiveInt(
        env.NODE_EGRESS_DAILY_LIMIT_BYTES,
        DEFAULT_NODE_EGRESS_DAILY_LIMIT_BYTES
      );
      if (!isNodeEgressUsageDatabase(env.DB)) {
        throw new Error('Node egress usage database batch is required');
      }
      const summary = await recordNodeEgressUsage({
        database: env.DB,
        nodes: mediaMtx.readNodes,
        now: new Date(scheduledTime),
        dailyLimitBytes,
        notify: createNodeEgressNotifier(env.DISCORD_ALERT_WEBHOOK_URL, timestamp, cron),
      });
      console.log(
        JSON.stringify({
          timestamp,
          source: SOURCE,
          severity: 'info',
          kind: 'event',
          cron,
          event: 'node_egress_usage_completed',
          summary,
          durationMs: Date.now() - startedAt,
        })
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          timestamp,
          source: SOURCE,
          severity: 'error',
          kind: 'event',
          cron,
          event: 'node_egress_usage_failed',
          errorName: error instanceof Error ? error.name : 'UnknownError',
          summary: 'node egress usage monitoring failed; lifecycle results remain independent.',
          durationMs: Date.now() - startedAt,
        })
      );
    }
  }

  if (lifecycleFailure !== undefined) throw lifecycleFailure;
}

function createNodeEgressNotifier(
  webhookUrl: string | undefined,
  timestamp: string,
  cron: string
): (message: string) => Promise<boolean> {
  return async (message) => {
    if (webhookUrl === undefined || webhookUrl === '') {
      console.warn(
        JSON.stringify({
          timestamp,
          source: SOURCE,
          severity: 'warn',
          kind: 'event',
          cron,
          event: 'node_egress_alert_webhook_unconfigured',
          summary: 'DISCORD_ALERT_WEBHOOK_URL is not set; the node egress alert was not delivered.',
        })
      );
      return false;
    }
    return createDiscordNotifier(webhookUrl)(message);
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('Invalid stream cron setting');
  return parsed;
}

function isNodeEgressUsageDatabase(
  database: StreamLifecycleDatabase
): database is StreamLifecycleDatabase & NodeEgressUsageDatabase {
  return 'batch' in database && typeof database.batch === 'function';
}
