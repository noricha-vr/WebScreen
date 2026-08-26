import { expect, test, type Page } from '@playwright/test';
import { join } from 'node:path';

// Playwright は Node で直接実行するため、JSON には import 属性が要る（Vite は不要）
import en from '../src/i18n/en.json' with { type: 'json' };
import ja from '../src/i18n/ja.json' with { type: 'json' };
import { E2E_FIXTURES } from '../playwright.config';
import { signIn } from './session';

// 公開プレビュー /{shortId}/ と履歴ドロップダウンの画面確認。
// D1 のフィクスチャは playwright.config.ts の webServer が seed.sql で流し込む。

// /{shortId}/ の表示言語は Accept-Language で決まる。Playwright の既定は en-US なので、
// 日本語を確認するテストのために明示する（英語の確認は専用の context を作る）。
test.use({ locale: 'ja-JP', extraHTTPHeaders: { 'Accept-Language': 'ja,en;q=0.8' } });

const SCREENSHOT_DIR = join(process.cwd(), '..', 'docs', 'tmp', 'screenshots');

function screenshotPath(name: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  return join(SCREENSHOT_DIR, `${name}-${stamp}.png`);
}

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

test.describe('公開プレビュー', () => {
  test('日本語でプレーヤー・コピーバー・期限が出る', async ({ page }) => {
    await page.goto(`/${E2E_FIXTURES.readyShortId}/`);

    await expect(
      page.getByRole('heading', { level: 1, name: E2E_FIXTURES.readyFilename })
    ).toBeVisible();
    await expect(page.locator('[data-preview-video]')).toHaveAttribute(
      'src',
      new RegExp(`/movies/${E2E_FIXTURES.readyShortId}\\.mp4$`)
    );
    await expect(page.locator('[data-preview-url]')).toHaveValue(
      new RegExp(`/movies/${E2E_FIXTURES.readyShortId}\\.mp4$`)
    );
    await expect(
      page.getByText(
        ja.preview.expiresInDays.replace('{days}', String(E2E_FIXTURES.readyRemainingDays))
      )
    ).toBeVisible();

    // 未ログインには操作 UI を出さない（動画そのものは誰でも見られる）
    await expect(page.locator('[data-preview] [data-pin-button]')).toHaveCount(0);
    await expect(page.locator('[data-preview] [data-rename-button]')).toHaveCount(0);

    await page.screenshot({ path: screenshotPath('01-preview-ja'), fullPage: true });
  });

  test('英語の Accept-Language では英語で出る', async ({ browser }) => {
    // Accept-Language は locale から組み立てられる（extraHTTPHeaders だけでは効かない）
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    await page.goto(`/${E2E_FIXTURES.readyShortId}/`);

    await expect(page.getByRole('button', { name: en.preview.copy })).toBeVisible();
    await expect(page.getByText(ja.preview.urlLabel)).toHaveCount(0);

    await page.screenshot({ path: screenshotPath('02-preview-en'), fullPage: true });
    await context.close();
  });

  test('URL をコピーするとコピー済みが出る', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/${E2E_FIXTURES.readyShortId}/`);
    await page.getByRole('button', { name: ja.preview.copy }).click();

    await expect(page.getByText(ja.preview.copied)).toBeVisible();
  });

  test('変換直後は動画 URL を一度だけ自動コピーする', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/ja/');
    await page.evaluate((shortId) => {
      sessionStorage.setItem('webscreen:auto-copy', shortId);
    }, E2E_FIXTURES.readyShortId);

    await page.goto(`/${E2E_FIXTURES.readyShortId}/`);
    const preview = page.locator('[data-preview]');
    await expect(preview).toHaveAttribute('data-copied', 'true');
    const previewUrl = await preview.locator('[data-preview-url]').inputValue();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(previewUrl);

    await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
    await page.reload();
    await expect(preview).not.toHaveAttribute('data-copied', 'true');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('sentinel');
  });

  test('通常閲覧では動画 URL を自動コピーしない', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/${E2E_FIXTURES.readyShortId}/`);

    await expect(page.locator('[data-preview]')).not.toHaveAttribute('data-copied', 'true');
  });

  test('ピン留め中の動画は無期限と表示する', async ({ page }) => {
    await page.goto(`/${E2E_FIXTURES.pinnedShortId}/`);

    await expect(page.getByText(ja.preview.neverExpires)).toBeVisible();
  });

  test.describe('404', () => {
    const notFoundPaths = [
      ['12 文字 base62 でない ID', '/notavalidid/'],
      ['長すぎる ID', '/abcdefghijklmnop/'],
      ['存在しない ID', '/ZZZZZZZZZZZZ/'],
      ['未完了（pending）の動画', `/${E2E_FIXTURES.pendingShortId}/`],
    ] as const;

    for (const [label, path] of notFoundPaths) {
      test(`${label} は 404`, async ({ request }) => {
        expect((await request.get(path)).status()).toBe(404);
      });
    }

    test('404 ページから戻る導線を出す', async ({ page }) => {
      await page.goto('/notavalidid/');

      await expect(
        page.getByRole('heading', { level: 1, name: ja.preview.notFoundHeading })
      ).toBeVisible();
      await expect(page.getByRole('link', { name: ja.preview.backHome })).toBeVisible();
    });
  });
});

test.describe('所有者の操作', () => {
  test('ファイル名を Enter で変更し、再読み込み後も保持する', async ({ page, context }) => {
    const filename = 'renamed-slides.mp4';
    await signIn(context, E2E_FIXTURES.ownerId);
    await page.goto(`/${E2E_FIXTURES.readyShortId}/`);

    await page.getByRole('button', { name: ja.preview.rename }).click();
    const input = page.locator('[data-filename-input]');
    await expect(input).toBeVisible();
    await input.fill(filename);
    await input.press('Enter');

    await expect(page.getByRole('heading', { level: 1, name: filename })).toBeVisible();
    await expect(page).toHaveTitle(`${filename} — WebScreen`);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: filename })).toBeVisible();
  });

  test('空白のみのファイル名は保存せず、元の名前を維持する', async ({ page, context }) => {
    await signIn(context, E2E_FIXTURES.ownerId);
    await page.goto(`/${E2E_FIXTURES.pinnedShortId}/`);

    await page.getByRole('button', { name: ja.preview.rename }).click();
    const input = page.locator('[data-filename-input]');
    await input.fill('   ');
    await input.press('Enter');

    await expect(
      page.getByRole('heading', { level: 1, name: E2E_FIXTURES.pinnedFilename })
    ).toBeVisible();
    await expect(input).toBeHidden();
  });

  test('編集中に Escape を押すと元の名前へ戻し保存しない', async ({ page, context }) => {
    let patchRequested = false;
    await signIn(context, E2E_FIXTURES.ownerId);
    await page.goto(`/${E2E_FIXTURES.pinnedShortId}/`);
    page.on('request', (request) => {
      if (request.method() === 'PATCH' && request.url().includes('/api/movies/')) {
        patchRequested = true;
      }
    });

    await page.getByRole('button', { name: ja.preview.rename }).click();
    const input = page.locator('[data-filename-input]');
    await input.fill('cancelled-name.mp4');
    await input.press('Escape');

    await expect(
      page.getByRole('heading', { level: 1, name: E2E_FIXTURES.pinnedFilename })
    ).toBeVisible();
    await expect(input).toBeHidden();
    expect(patchRequested).toBe(false);
  });

  test('ピン留めを解除すると保管期限が戻る', async ({ page, context }) => {
    await signIn(context, E2E_FIXTURES.ownerId);
    await page.goto(`/${E2E_FIXTURES.pinnedShortId}/`);

    await page.getByRole('button', { name: ja.preview.unpin }).click();

    await expect(
      page.getByText(
        ja.preview.expiresInDays.replace(
          '{days}',
          String(E2E_FIXTURES.pinnedRemainingDaysAfterUnpin)
        )
      )
    ).toBeVisible();
    await expect(page.getByRole('button', { name: ja.preview.pin })).toBeVisible();

    await page.screenshot({ path: screenshotPath('04-preview-owner-ja'), fullPage: true });
  });

  test('削除は確認してから実行し、URL は 404 になる', async ({ page, context, request }) => {
    await signIn(context, E2E_FIXTURES.ownerId);
    await page.goto(`/${E2E_FIXTURES.deletableShortId}/`);

    // ブラウザの confirm() ではなく画面内の確認 UI で二段階にする
    await page.locator('[data-preview] [data-delete-trigger]').click();
    await expect(page.getByText(ja.actions.deleteConfirm)).toBeVisible();
    await page.locator('[data-preview] [data-delete-yes]').click();

    await expect(page.getByText(ja.preview.deletedHeading)).toBeVisible();
    expect((await request.get(`/${E2E_FIXTURES.deletableShortId}/`)).status()).toBe(404);
  });
});

test.describe('履歴ドロップダウン', () => {
  test('ログイン時に一覧を出し、行から動画ページへ移動できる', async ({ page }) => {
    await stubHistory(page, [
      historyMovie(),
      historyMovie({ shortId: E2E_FIXTURES.pinnedShortId, filename: 'pinned.mp4', pinned: true }),
      historyMovie({ shortId: 'E2EPending99', filename: 'wip.pdf', status: 'pending' }),
    ]);
    await page.goto('/ja/');

    const menu = page.locator('[data-history-menu]');
    await menu.locator('summary').click();

    const rows = menu.locator('[data-history-row]');
    await expect(rows).toHaveCount(3);
    await expect(rows.first().getByText(E2E_FIXTURES.readyFilename)).toBeVisible();
    await expect(rows.first().getByText('3 分前')).toBeVisible();
    await expect(rows.nth(1).getByText(ja.history.pinned)).toBeVisible();
    await expect(rows.nth(2).getByText(ja.history.processing)).toBeVisible();

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
