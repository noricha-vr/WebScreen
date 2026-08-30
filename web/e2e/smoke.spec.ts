import { expect, test } from '@playwright/test';

// Playwright は Node で直接実行するため、JSON には import 属性が要る（Vite は不要）
import ja from '../src/i18n/ja.json' with { type: 'json' };

// ビルド済み Worker（wrangler dev）に対する煙テスト。
// ページが配信されること、COOP/COEP が静的・動的の両経路で付くことを見る。

test('日本語トップページが表示される', async ({ page }) => {
  await page.goto('/ja/');

  // 見出しはスケルトンの "WebScreen β" から、ヒーローの訴求文（辞書が正本）に変わった
  await expect(page.getByRole('heading', { level: 1, name: ja.hero.title })).toBeVisible();
});

test('英語トップページが表示される', async ({ page }) => {
  await page.goto('/en/');

  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('health が保持期間バッチの鮮度を返す', async ({ request }) => {
  // Cloudflare のダッシュボードを見に行かなくても、バッチが動いているかを外から確認できること。
  // stale まで見るのは、migration の適用漏れ（cron が読めず error になる）を検出するため。
  const response = await request.get('/api/health/');
  const body = await response.json();

  expect(body.status).toBe('ok');
  expect(body.cron.stale).toBe(false);
  expect(typeof body.cron.lastSuccessAt).toBe('string');
  expect(body.cron.ageSeconds).toBeGreaterThanOrEqual(0);
});

test.describe('cross-origin isolation', () => {
  // 静的アセット（public/_headers）と Worker レスポンス（middleware）は
  // ヘッダーの供給元が別なので、両方を確認しないと片方の欠落に気づけない。
  const paths = [
    ['静的ページ', '/ja/'],
    ['API ルート', '/api/health/'],
  ] as const;

  for (const [label, path] of paths) {
    test(`${label} にセキュリティヘッダーが付く`, async ({ request }) => {
      const response = await request.get(path);

      expect(response.status()).toBe(200);
      expect(response.headers()['cross-origin-opener-policy']).toBe('same-origin');
      expect(response.headers()['cross-origin-embedder-policy']).toBe('credentialless');
      expect(response.headers()['x-content-type-options']).toBe('nosniff');
      expect(response.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
    });
  }
});
