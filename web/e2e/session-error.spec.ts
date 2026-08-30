import { expect, test } from '@playwright/test';

import ja from '../src/i18n/ja.json' with { type: 'json' };
import { E2E_FIXTURES } from '../playwright.config';
import { signIn } from './session';

// 認証基盤が落ちた時の表示。guest 表示へ黙って倒すと障害に気づけないので、
// 「通常の guest 表示 + 赤いアラート」の併存になっていることを固定する。

test.use({ locale: 'ja-JP', extraHTTPHeaders: { 'Accept-Language': 'ja,en;q=0.8' } });

test('/api/me/ が 5xx なら、ログイン導線を残したままエラーを知らせる', async ({
  page,
  context,
}) => {
  await signIn(context, E2E_FIXTURES.ownerId);
  await page.route('**/api/me/', (route) => route.fulfill({ status: 500, body: '{}' }));

  await page.goto('/ja/');

  await expect(page.locator('html')).toHaveAttribute('data-auth-state', 'error');

  // 復帰手段（ログイン導線・トップの案内）を消さない。
  await expect(page.getByRole('link', { name: ja.nav.login, exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: ja.hero.title })).toBeVisible();

  // ログイン済み前提の操作は出さない（本人だと確認できていないため）。
  await expect(page.locator('[data-history-menu]')).toBeHidden();

  const alert = page.getByRole('alert').filter({ hasText: ja.nav.sessionUnavailable });
  await expect(alert).toBeVisible();
});

test('401 は通常の未ログイン表示のままにする', async ({ page }) => {
  await page.goto('/ja/');

  await expect(page.locator('html')).toHaveAttribute('data-auth-state', 'guest');
  await expect(page.getByRole('link', { name: ja.nav.login, exact: true })).toBeVisible();
  await expect(page.locator('[data-session-error]')).toBeHidden();
});
