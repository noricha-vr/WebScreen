/**
 * 保持期間バッチの Worker（cron トリガー専用）。
 *
 * entry 層なので責務は 3 つだけ: bindings をサービスの型に渡す・実行時刻を注入する・
 * 結果を構造化ログにする。判定ロジックは services/retention.ts が持つ。
 * fetch ハンドラは持たない（HTTP からは叩けない）。
 */

import {
  runRetention,
  type RetentionBucket,
  type RetentionDatabase,
} from '../../src/lib/services/retention';

/**
 * 使う binding だけを宣言する。@cloudflare/workers-types を入れず、サービス側の
 * 最小インターフェースをそのまま契約にする（実 binding は構造的に適合する）。
 */
interface Env {
  DB: RetentionDatabase;
  BUCKET: RetentionBucket;
}

/** workerd が scheduled ハンドラへ渡すイベント（使うフィールドのみ）。 */
interface ScheduledEvent {
  scheduledTime: number;
  cron: string;
}

const SOURCE = 'webscreen-beta-cron';

export default {
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    // Date.now を呼んでよいのはこの層だけ。サービスへは値として渡す。
    const startedAt = Date.now();

    try {
      const summary = await runRetention({
        database: env.DB,
        bucket: env.BUCKET,
        now: new Date(event.scheduledTime),
      });

      console.log(
        JSON.stringify({
          timestamp: new Date(event.scheduledTime).toISOString(),
          source: SOURCE,
          severity: 'info',
          kind: 'event',
          cron: event.cron,
          summary: `retention backfilled ${summary.backfilledPinned} pinned expiries, deleted ${summary.deletedMovies} expired movies, ${summary.deletedOrphans} orphans, ${summary.deletedFailed} failed rows, ${summary.deletedCaptures} captures.`,
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
  },
};
