/**
 * cron トリガー専用の Worker。
 *
 * 2 本のスケジュールを 1 つの Worker で受ける（web/cron/wrangler.jsonc の triggers.crons）:
 *   - 保持期間バッチ本体（期限切れの掃除）
 *   - その死活監視（バッチが止まっていないかを見て通知する）
 *
 * entry 層なので責務は 3 つだけ: bindings をサービスの型に渡す・実行時刻を注入する・
 * 結果を構造化ログにする。判定ロジックは services/retention.ts と services/cron-health.ts が持つ。
 * fetch ハンドラは持たない（HTTP からは叩けない）。
 */

import {
  runRetention,
  type RetentionBucket,
  type RetentionDatabase,
} from '../../src/lib/services/retention';
import {
  recordCronRun,
  RETENTION_RUN_NAME,
  type CronRunDatabase,
} from '../../src/lib/services/cron-health';
import type { CachePurgeSettings } from '../../src/lib/services/cache-purge';
import { runAlertCron, type AlertEnv } from './alert';

/**
 * 使う binding だけを宣言する。@cloudflare/workers-types を入れず、サービス側の
 * 最小インターフェースをそのまま契約にする（実 binding は構造的に適合する）。
 */
interface Env extends AlertEnv {
  DB: RetentionDatabase & CronRunDatabase;
  BUCKET: RetentionBucket;
  /** 動画の配信元。web/wrangler.jsonc の同名 var と同じ値であること（purge の URL に使う）。 */
  R2_PUBLIC_BASE_URL: string;
  CLOUDFLARE_ZONE_ID?: string;
  /** secret。未投入なら purge を諦めて warn だけ出す（掃除は続く）。 */
  CLOUDFLARE_PURGE_TOKEN?: string;
}

/** workerd が scheduled ハンドラへ渡すイベント（使うフィールドのみ）。 */
interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

const SOURCE = 'webscreen-beta-cron';

/**
 * 受け付けるスケジュール式。web/cron/wrangler.jsonc の triggers.crons と一致させること
 * （wrangler の設定と TS で二重化は避けられないため）。
 */
const RETENTION_CRON = '17 * * * *';
const ALERT_CRON = '47 * * * *';

/**
 * 式の表記ゆれ（前後の空白・フィールド間の連続空白）を吸収する。workerd が渡す文字列は
 * 設定の書き方に依存するので、素の === だけで振り分けると空白 1 つで分岐が変わる。
 */
function normalizeCron(expression: string): string {
  return expression.trim().replace(/\s+/g, ' ');
}

export default {
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const cron = normalizeCron(event.cron);

    // 監視だけを厳密一致にする。残りは retention へ倒す（fail-open）。式を変えた時に
    // 掃除が止まる方が、監視が 1 回鳴らないより高くつくため。知らない式は error に出して
    // 気づけるようにする（黙って握り潰さない）。
    if (cron === ALERT_CRON) {
      await runAlertCron(env, event.scheduledTime, cron);
      return;
    }

    if (cron !== RETENTION_CRON) {
      console.error(
        JSON.stringify({
          timestamp: new Date(event.scheduledTime).toISOString(),
          source: SOURCE,
          severity: 'error',
          kind: 'event',
          cron,
          event: 'cron_trigger_unknown',
          summary:
            'No handler is registered for this cron expression; running retention as a fallback.',
        })
      );
    }
    await runRetentionCron(env, event, cron);
  },
};

/** 削除した動画のキャッシュを落とすための設定を bindings から組む。 */
function cachePurgeSettings(env: Env): CachePurgeSettings {
  return {
    publicBaseUrl: env.R2_PUBLIC_BASE_URL,
    zoneId: env.CLOUDFLARE_ZONE_ID ?? '',
    apiToken: env.CLOUDFLARE_PURGE_TOKEN ?? '',
    source: SOURCE,
  };
}

/** 保持期間バッチ本体。成功したら実行記録を残し、件数を 1 行 JSON で出す。 */
async function runRetentionCron(env: Env, event: ScheduledEvent, cron: string): Promise<void> {
  // Date.now を呼んでよいのはこの層だけ。サービスへは値として渡す。
  const startedAt = Date.now();

  try {
    const summary = await runRetention({
      database: env.DB,
      bucket: env.BUCKET,
      now: new Date(event.scheduledTime),
      cachePurge: cachePurgeSettings(env),
    });

    // 死活監視の根拠になる記録。ここが失敗したら成功として扱わない（rethrow に任せる）。
    // 記録が無いまま「成功」にすると、監視側からは止まって見えるのに誰も直さない状態になる。
    await recordCronRun({
      database: env.DB,
      name: RETENTION_RUN_NAME,
      at: new Date(event.scheduledTime),
      summary,
    });

    // error は回収不能な異常だけに使う。実体だけ消えた行（stranded / missing）は
    // 壊れた URL が残り続けるので error、R2 の削除失敗（deferred）・打ち切り（capped）・
    // 監査の失敗（auditErrors = 検出が働いていない）は次回に回せるので warn。
    // キャッシュ purge の失敗も warn（削除自体は済んでおり、残っても 120 分で切れる）。
    // 競合で何もしなかった行（skipped）は正常なので info。
    const severity =
      summary.strandedMovies > 0 || summary.missingObjectRows > 0
        ? 'error'
        : summary.deferredObjectDeletions > 0 ||
            summary.sweepCapped ||
            summary.auditErrors > 0 ||
            summary.cachePurgeFailures > 0
          ? 'warn'
          : 'info';
    const log =
      severity === 'error' ? console.error : severity === 'warn' ? console.warn : console.log;
    const deferred =
      summary.deferredObjectDeletions > 0
        ? ` ${summary.deferredObjectDeletions} object deletions deferred to the next run.`
        : '';
    const capped = summary.sweepCapped
      ? ' A sweep hit a per-run cap; the rest waits for the next run.'
      : '';
    const skipped =
      summary.skippedRows > 0 ? ` ${summary.skippedRows} rows skipped this run.` : '';
    const auditErrors =
      summary.auditErrors > 0 ? ` ${summary.auditErrors} audit checks failed.` : '';
    const purge = ` ${summary.cachePurgeRequests} cache purge requests (${summary.cachePurgeFailures} failed).`;

    log(
      JSON.stringify({
        timestamp: new Date(event.scheduledTime).toISOString(),
        source: SOURCE,
        severity,
        kind: 'event',
        cron,
        summary: `retention backfilled ${summary.backfilledPinned} pinned expiries, deleted ${summary.deletedMovies} expired movies (${summary.strandedMovies} stranded), ${summary.deletedOrphans} orphans, ${summary.deletedFailed} failed rows, ${summary.deletedCaptures} captures; audited ${summary.checkedReadyRows} ready rows (${summary.missingObjectRows} missing objects).${purge}${deferred}${capped}${skipped}${auditErrors}`,
        detail: summary,
        durationMs: Date.now() - startedAt,
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        timestamp: new Date(event.scheduledTime).toISOString(),
        source: SOURCE,
        severity: 'error',
        kind: 'event',
        cron,
        summary: 'retention run failed.',
        error_message: error instanceof Error ? error.message : String(error),
        stack_trace: error instanceof Error ? error.stack : undefined,
        durationMs: Date.now() - startedAt,
      })
    );
    // 実行を失敗として記録させるため握りつぶさない（Cloudflare 側の
    // cron 実行履歴と observability で異常が見えるようにする）。
    throw error;
  }
}
