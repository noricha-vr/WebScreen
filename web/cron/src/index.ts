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
import { runAlertCron, type AlertEnv } from './alert';

/**
 * 使う binding だけを宣言する。@cloudflare/workers-types を入れず、サービス側の
 * 最小インターフェースをそのまま契約にする（実 binding は構造的に適合する）。
 */
interface Env extends AlertEnv {
  DB: RetentionDatabase & CronRunDatabase;
  BUCKET: RetentionBucket;
}

/** workerd が scheduled ハンドラへ渡すイベント（使うフィールドのみ）。 */
interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

const SOURCE = 'webscreen-beta-cron';

/**
 * 受け付けるスケジュール式。web/cron/wrangler.jsonc の triggers.crons と一致させること
 * （wrangler の設定と TS で二重化は避けられないため、片方だけ変えると下の default に落ちる）。
 *
 * 両方を明示マッチさせ、知らない式は error にする。「alert 以外は retention」と書くと、
 * 式を変えた時に監視側が黙って動かなくなり、dead-man's switch 自身が静かに死ぬ。
 */
const RETENTION_CRON = '17 * * * *';
const ALERT_CRON = '47 * * * *';

export default {
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    if (event.cron === ALERT_CRON) {
      await runAlertCron(env, event.scheduledTime, event.cron);
      return;
    }
    if (event.cron === RETENTION_CRON) {
      await runRetentionCron(env, event);
      return;
    }

    console.error(
      JSON.stringify({
        timestamp: new Date(event.scheduledTime).toISOString(),
        source: SOURCE,
        severity: 'error',
        kind: 'event',
        cron: event.cron,
        event: 'cron_trigger_unknown',
        summary: 'No handler is registered for this cron expression.',
      })
    );
  },
};

/** 保持期間バッチ本体。成功したら実行記録を残し、件数を 1 行 JSON で出す。 */
async function runRetentionCron(env: Env, event: ScheduledEvent): Promise<void> {
  // Date.now を呼んでよいのはこの層だけ。サービスへは値として渡す。
  const startedAt = Date.now();

  try {
    const summary = await runRetention({
      database: env.DB,
      bucket: env.BUCKET,
      now: new Date(event.scheduledTime),
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
    // 競合で何もしなかった行（skipped）は正常なので info。
    const severity =
      summary.strandedMovies > 0 || summary.missingObjectRows > 0
        ? 'error'
        : summary.deferredObjectDeletions > 0 || summary.sweepCapped || summary.auditErrors > 0
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

    log(
      JSON.stringify({
        timestamp: new Date(event.scheduledTime).toISOString(),
        source: SOURCE,
        severity,
        kind: 'event',
        cron: event.cron,
        summary: `retention backfilled ${summary.backfilledPinned} pinned expiries, deleted ${summary.deletedMovies} expired movies (${summary.strandedMovies} stranded), ${summary.deletedOrphans} orphans, ${summary.deletedFailed} failed rows, ${summary.deletedCaptures} captures; audited ${summary.checkedReadyRows} ready rows (${summary.missingObjectRows} missing objects).${deferred}${capped}${skipped}${auditErrors}`,
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
        cron: event.cron,
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
