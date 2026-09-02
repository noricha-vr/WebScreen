import { expect, test, type Page } from '@playwright/test';

// Playwright は Node で直接実行するため、JSON には import 属性が要る（Vite は不要）
import ja from '../src/i18n/ja.json' with { type: 'json' };
import { E2E_FIXTURES } from '../playwright.config';
import { screenshotPath } from './screenshot';

// ヘッダーの履歴ドロップダウンの確認。一覧の描画と削除操作を見るため、
// 実データではなく /api/me/ と /api/history/ を差し替えて動かす。

// 表示言語は Accept-Language で決まる。Playwright の既定は en-US なので、
// 日本語の文言で確認するために明示する。
test.use({ locale: 'ja-JP', extraHTTPHeaders: { 'Accept-Language': 'ja,en;q=0.8' } });

/** 履歴 API を差し替える（実データではなく一覧の描画と削除操作を見るため）。 */
async function stubHistory(page: Page, movies: unknown[]): Promise<void> {
  await page.route('**/api/me/', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"name":"noricha"}' })
  );
  await page.route('**/api/history/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ movies }),
    })
  );
}

function historyMovie(overrides: Record<string, unknown> = {}) {
  return {
    shortId: E2E_FIXTURES.readyShortId,
    filename: E2E_FIXTURES.readyFilename,
    status: 'ready',
    pinned: false,
    createdAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000).toISOString(),
    publicUrl: `https://public.example/movies/${E2E_FIXTURES.readyShortId}.mp4`,
    ...overrides,
  };
}

test.describe('履歴ドロップダウン', () => {
  test('ログイン時に一覧を出し、行から動画ページへ移動できる', async ({ page }) => {
    await stubHistory(page, [
      historyMovie(),
      historyMovie({ shortId: E2E_FIXTURES.pinnedShortId, filename: 'pinned.mp4', pinned: true }),
    ]);
    await page.goto('/ja/');

    const menu = page.locator('[data-history-menu]');
    await menu.locator('summary').click();

    const rows = menu.locator('[data-history-row]');
    await expect(rows).toHaveCount(2);
    await expect(rows.first().getByText(E2E_FIXTURES.readyFilename)).toBeVisible();
    await expect(rows.first().getByText('3 分前')).toBeVisible();
    await expect(rows.nth(1).getByText(ja.history.pinned)).toBeVisible();

    await page.screenshot({ path: screenshotPath('03-history-ja') });

    await rows.first().locator('[data-entry-link]').click();
    await expect(page).toHaveURL(new RegExp(`/${E2E_FIXTURES.readyShortId}/$`));
  });

  test('変換した動画が無ければ空の案内を出す', async ({ page }) => {
    await stubHistory(page, []);
    await page.goto('/ja/');

    const menu = page.locator('[data-history-menu]');
    await menu.locator('summary').click();

    await expect(menu.getByText(ja.history.empty)).toBeVisible();
  });

  test('外側のクリックで閉じ、内側のクリックでは閉じない', async ({ page }) => {
    await stubHistory(page, [historyMovie()]);
    await page.goto('/ja/');

    const menu = page.locator('[data-history-menu]');
    await menu.locator('summary').click();
    await expect(menu.locator('[data-history-row]')).toHaveCount(1);

    // exact 指定は「変換した動画はまだありません」（空表示）との二重マッチを避けるため
    await menu.getByText(ja.history.heading, { exact: true }).click();
    await expect(menu).toHaveJSProperty('open', true);

    // メニューから離れた位置を直接クリックする（間に何が描かれていても外側だと分かる座標）
    await page.mouse.click(20, 500);
    await expect(menu).toHaveJSProperty('open', false);
  });

  test('行の削除は確認してから実行し、一覧から消える', async ({ page }) => {
    await stubHistory(page, [historyMovie(), historyMovie({ shortId: 'E2EOther0002' })]);
    await page.route('**/api/movies/*/', (route) =>
      route.request().method() === 'DELETE' ? route.fulfill({ status: 204 }) : route.continue()
    );
    await page.goto('/ja/');

    const menu = page.locator('[data-history-menu]');
    await menu.locator('summary').click();

    const rows = menu.locator('[data-history-row]');
    await rows.first().locator('[data-delete-trigger]').click();
    await rows.first().getByRole('button', { name: ja.actions.deleteYes }).click();

    await expect(rows).toHaveCount(1);
    // 削除は行を DOM から外すので、外側クリック判定が誤発火して閉じないこと
    await expect(menu).toHaveJSProperty('open', true);
  });

  test('取得に失敗したらエラーを出す', async ({ page }) => {
    await page.route('**/api/me/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"name":"noricha"}' })
    );
    await page.route('**/api/history/', (route) => route.fulfill({ status: 500, body: '{}' }));
    await page.goto('/ja/');

    const menu = page.locator('[data-history-menu]');
    await menu.locator('summary').click();

    await expect(menu.getByText(ja.history.error)).toBeVisible();
  });
});
