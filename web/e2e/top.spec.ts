import { expect, test, type Page } from '@playwright/test';

// Playwright は Node で直接実行するため、JSON には import 属性が要る（Vite は不要）
import en from '../src/i18n/en.json' with { type: 'json' };
import ja from '../src/i18n/ja.json' with { type: 'json' };

// トップ画面の 2 状態（未ログイン / ログイン済み）と、変換 UI の状態遷移を見る。
// ログイン済みは /api/me/ を 200 に差し替えて再現する（OAuth は後続タスクの担当）。

/** ログイン済みとして描画させる。Cookie ではなく /api/me/ の応答で状態が決まる。 */
async function signIn(page: Page): Promise<void> {
  await page.route('**/api/me/', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ name: 'noricha' }),
    })
  );
}

test.describe('未ログイン', () => {
  test('日本語トップに Discord ログインの導線と仕様が出る', async ({ page }) => {
    await page.goto('/ja/');

    const cta = page.getByRole('link', { name: ja.hero.cta });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute('href', '/api/auth/discord/');

    // 仕様リストはヒーローと変換パネルの両方にあるので、未ログイン側に絞って見る
    const hero = page.locator('[data-auth-only="guest"]');
    await expect(hero.getByText(ja.spec.maxSize)).toBeVisible();
    await expect(hero.getByText(ja.spec.retention)).toBeVisible();
    // ログイン前に変換パネルは出さない
    await expect(page.locator('[data-convert-panel]')).toBeHidden();
  });

  test('英語トップの文言が英語辞書から出る', async ({ page }) => {
    await page.goto('/en/');

    await expect(page.getByRole('heading', { level: 1, name: en.hero.title })).toBeVisible();
    await expect(page.getByRole('link', { name: en.hero.cta })).toBeVisible();
    await expect(page.getByText(ja.hero.cta)).toHaveCount(0);
  });

  test('言語切替リンクで同じページの別ロケールへ移動する', async ({ page }) => {
    await page.goto('/ja/privacy/');
    await page.getByRole('link', { name: ja.nav.langSwitch }).click();

    await expect(page).toHaveURL(/\/en\/privacy\/$/);
    await expect(page.getByRole('heading', { level: 1, name: en.privacy.heading })).toBeVisible();
  });
});

test.describe('ルートのリダイレクト', () => {
  test('既定は日本語トップへ送る', async ({ request }) => {
    const response = await request.get('/', { maxRedirects: 0 });

    expect(response.status()).toBe(302);
    expect(response.headers()['location']).toBe('/ja/');
  });

  test('Accept-Language が英語なら英語トップへ送る', async ({ request }) => {
    const response = await request.get('/', {
      maxRedirects: 0,
      headers: { 'Accept-Language': 'en-US,en;q=0.9' },
    });

    expect(response.status()).toBe(302);
    expect(response.headers()['location']).toBe('/en/');
  });
});

test.describe('ログイン済み', () => {
  test('ヘッダーがアカウント表示に切り替わり変換パネルが出る', async ({ page }) => {
    await signIn(page);
    await page.goto('/ja/');

    await expect(page.getByRole('link', { name: ja.nav.upload })).toBeVisible();
    await expect(page.getByText('noricha')).toBeVisible();
    await expect(page.getByRole('link', { name: ja.hero.cta })).toBeHidden();
    await expect(page.getByText(ja.convert.dropzoneTitle)).toBeVisible();
  });

  test('ファイルを選ぶと変換中 → アップロード → 完了まで進む', async ({ page }) => {
    await signIn(page);
    await page.goto('/ja/');

    const panel = page.locator('[data-convert-panel]');
    await panel.locator('[data-file-input]').setInputFiles({
      name: 'slides.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4 demo'),
    });

    await expect(panel).toHaveAttribute('data-phase', 'converting');
    await expect(page.getByText('slides.pdf')).toBeVisible();

    // 状態ごとのブロックは同じ表示項目を持つため、完了ブロックに絞って確認する
    const doneBlock = panel.locator('[data-when-phase="done"]');
    await expect(panel).toHaveAttribute('data-phase', 'done');
    await expect(doneBlock.getByText(ja.convert.done)).toBeVisible();
    await expect(doneBlock.locator('[data-result-url]')).toHaveValue(
      /\/movies\/[0-9A-Za-z]{12}\.mp4$/
    );

    await page.getByRole('button', { name: ja.convert.copy }).click();
    await expect(page.getByText(ja.convert.copied)).toBeVisible();

    await page.getByRole('button', { name: ja.convert.again }).click();
    await expect(panel).toHaveAttribute('data-phase', 'idle');
  });

  test('対応外の形式は変換を始めずエラーを出す', async ({ page }) => {
    await signIn(page);
    await page.goto('/ja/');

    const panel = page.locator('[data-convert-panel]');
    await panel.locator('[data-file-input]').setInputFiles({
      name: 'archive.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('PK'),
    });

    await expect(panel).toHaveAttribute('data-phase', 'error');
    await expect(page.getByText(ja.convert.errorUnsupported)).toBeVisible();
  });

  test('URL からの変換も同じ流れで完了する', async ({ page }) => {
    await signIn(page);
    await page.goto('/ja/');

    const panel = page.locator('[data-convert-panel]');
    await panel.locator('[data-url-input]').fill('https://example.com');
    await page.getByRole('button', { name: ja.convert.urlSubmit }).click();

    await expect(panel).toHaveAttribute('data-phase', 'done');
  });
});
