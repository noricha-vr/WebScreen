import { describe, expect, test } from 'bun:test';

import { postDiscordWebhook } from '../../src/lib/infra/discord-webhook';

const WEBHOOK_URL = 'https://discord.example/api/webhooks/1/token-placeholder';

/** console.error を差し替えて、出力された 1 行 JSON を取る。 */
async function captureErrorLogs(run: () => Promise<void>): Promise<string[]> {
  const original = console.error;
  const entries: string[] = [];
  console.error = (entry: unknown) => {
    entries.push(String(entry));
  };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return entries;
}

describe('postDiscordWebhook', () => {
  test('本文を JSON の content として POST し、成功なら true', async () => {
    let seen: { url: string; init: RequestInit | undefined } | null = null;

    const delivered = await postDiscordWebhook(WEBHOOK_URL, 'バッチが停止しています', (url, init) => {
      seen = { url: String(url), init };
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    expect(delivered).toBe(true);
    expect(seen!.url).toBe(WEBHOOK_URL);
    expect(seen!.init?.method).toBe('POST');
    expect(JSON.parse(String(seen!.init?.body))).toEqual({ content: 'バッチが停止しています' });
  });

  test('Discord が拒否したら false を返し、例外にしない', async () => {
    let delivered = true;
    const logs = await captureErrorLogs(async () => {
      delivered = await postDiscordWebhook(WEBHOOK_URL, 'x', () =>
        Promise.resolve(new Response('rate limited', { status: 429 }))
      );
    });

    expect(delivered).toBe(false);
    expect(JSON.parse(logs[0]!).status).toBe(429);
  });

  test('ネットワーク障害でも false を返し、通知の失敗で呼び出し側を落とさない', async () => {
    let delivered = true;
    const logs = await captureErrorLogs(async () => {
      delivered = await postDiscordWebhook(WEBHOOK_URL, 'x', () =>
        Promise.reject(new Error(`connect failed to ${WEBHOOK_URL}`))
      );
    });

    expect(delivered).toBe(false);
    expect(logs).toHaveLength(1);
  });

  test('ログに webhook URL と例外メッセージを出さない', async () => {
    // URL 自体が資格情報なので、fetch の失敗メッセージ経由でも漏らさない。
    const logs = await captureErrorLogs(async () => {
      await postDiscordWebhook(WEBHOOK_URL, 'x', () =>
        Promise.reject(new Error(`connect failed to ${WEBHOOK_URL}`))
      );
    });

    expect(logs[0]).not.toContain('token-placeholder');
    expect(logs[0]).not.toContain('discord.example');
    expect(logs[0]).not.toContain('connect failed');
  });

  test('応答が無い時に待ち続けないようタイムアウトを渡す', async () => {
    let signal: AbortSignal | null | undefined;

    await postDiscordWebhook(WEBHOOK_URL, 'x', (_url, init) => {
      signal = init?.signal;
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  test('Discord の上限を超える本文は切り詰めて送る', async () => {
    let body = '';
    await postDiscordWebhook(WEBHOOK_URL, 'あ'.repeat(2500), (_url, init) => {
      body = String(init?.body);
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    expect(JSON.parse(body).content).toHaveLength(2000);
  });
});
