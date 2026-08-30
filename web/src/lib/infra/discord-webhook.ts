/**
 * Discord の Incoming Webhook へ運用通知を送る境界。
 *
 * 既存の infra/discord.ts は OAuth（ログイン）専用なので分けている。こちらは
 * 認証に関与せず、URL 自体が資格情報である webhook だけを扱う。
 *
 * 例外を投げないのが契約。通知は監視の付帯機能であり、送信の失敗で本体のジョブを
 * 落とすと「掃除は動いていたのに通知の失敗で異常終了」という逆転が起きる。
 */

const SOURCE = 'webscreen-beta-cron';

/** Discord のメッセージ本文の上限（超えると 400 で落ちるので手前で切る）。 */
const MAX_CONTENT_LENGTH = 2000;

/**
 * 送信を諦めるまでの時間。Discord が応答しない時に cron の実行時間を食い潰さないため
 * （通知は付帯機能であり、待ち続けて本体の掃除の枠を削る価値はない）。
 */
const REQUEST_TIMEOUT_MS = 5000;

/** fetch の注入境界（テストで実ネットワークを使わないため）。 */
export type WebhookFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const defaultFetch: WebhookFetcher = (input, init) => globalThis.fetch(input, init);

/**
 * 失敗を 1 行 JSON で残す。
 *
 * webhook URL は資格情報そのものなので、URL も例外の message も出さない
 * （fetch の失敗メッセージには URL が混ざることがある）。ログに出すのは固定の
 * イベント名と HTTP ステータスだけで、Cloudflare observability での絞り込みには足りる。
 */
function logFailure(reason: 'request_failed' | 'rejected', status?: number): void {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      source: SOURCE,
      severity: 'error',
      kind: 'event',
      event: 'cron_alert_webhook_failed',
      reason,
      status,
      summary: `Discord webhook delivery failed (${reason}).`,
    })
  );
}

/**
 * 通知を 1 通送る。送れたら true、送れなければ false（例外は投げない）。
 *
 * 呼び出し側は false を「未送信」として扱い、送信済みの記録を残さないこと
 * （残すと連投防止の間隔に入り、本当は届いていないのに次が抑止される）。
 */
export async function postDiscordWebhook(
  webhookUrl: string,
  content: string,
  fetcher: WebhookFetcher = defaultFetch
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetcher(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, MAX_CONTENT_LENGTH) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // タイムアウト（AbortError）もここに来る。理由で分けず、送れなかった事実だけを残す。
    logFailure('request_failed');
    return false;
  }

  if (!response.ok) {
    logFailure('rejected', response.status);
    return false;
  }
  return true;
}
