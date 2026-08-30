/**
 * 死活監視の cron（保持期間バッチが止まっていないかを見る側）。
 *
 * entry 層なので責務は 3 つだけ: binding をサービスの型に渡す・実行時刻を注入する・
 * 結果を構造化ログにする。判定は services/cron-health.ts が持つ。
 */

import {
  createDiscordNotifier,
  runRetentionAlert,
  type CronRunDatabase,
} from '../../src/lib/services/cron-health';

const SOURCE = 'webscreen-beta-cron';

export interface AlertEnv {
  DB: CronRunDatabase;
  /** Discord の Incoming Webhook URL（secret）。未設定なら通知せず warn を残す。 */
  DISCORD_ALERT_WEBHOOK_URL?: string;
}

/** 保持期間バッチの鮮度を確認し、閾値を超えていれば通知する。 */
export async function runAlertCron(
  env: AlertEnv,
  scheduledTime: number,
  cron: string
): Promise<void> {
  const timestamp = new Date(scheduledTime).toISOString();
  const webhookUrl = env.DISCORD_ALERT_WEBHOOK_URL;

  const result = await runRetentionAlert({
    database: env.DB,
    now: new Date(scheduledTime),
    notify: async (message) => {
      if (webhookUrl === undefined || webhookUrl === '') {
        // 通知先が無いのに「送った」と記録すると連投防止が働いて次回以降も黙るため、
        // 未送信（false）として返す。設定漏れ自体はログで気づけるようにする。
        console.warn(
          JSON.stringify({
            timestamp,
            source: SOURCE,
            severity: 'warn',
            kind: 'event',
            cron,
            event: 'cron_alert_webhook_unconfigured',
            summary: 'DISCORD_ALERT_WEBHOOK_URL is not set; the alert was not delivered.',
          })
        );
        return false;
      }
      return createDiscordNotifier(webhookUrl)(message);
    },
  });

  // 通知すべきなのに送れなかった時だけ error（監視が機能していない印）。
  // 停止している間は連投防止で黙る回も warn にする（decision で切り替えると、
  // 止まったままの実行が info で流れて、ログだけ見た人が正常と誤読する）。
  const severity = result.notifyFailed ? 'error' : result.freshness.stale ? 'warn' : 'info';
  const log = severity === 'error' ? console.error : severity === 'warn' ? console.warn : console.log;

  log(
    JSON.stringify({
      timestamp,
      source: SOURCE,
      severity,
      kind: 'event',
      cron,
      summary: `retention freshness check: ${result.decision} (stale=${result.freshness.stale}, ageSeconds=${result.freshness.ageSeconds ?? 'unknown'}).`,
      detail: result,
    })
  );
}
