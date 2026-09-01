import { expect, test, type Page } from '@playwright/test';

import en from '../src/i18n/en.json' with { type: 'json' };
import ja from '../src/i18n/ja.json' with { type: 'json' };

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
    await expect(cta).toHaveAttribute('href', '/api/auth/login/');

    const hero = page.locator('[data-auth-only~="guest"]');
    await expect(hero.getByText(ja.spec.maxSize)).toBeVisible();
    await expect(hero.getByText(ja.spec.retention)).toBeVisible();
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
    await page.locator('footer').getByRole('link', { name: ja.footer.langSwitch }).click();

    await expect(page).toHaveURL(/\/en\/privacy\/$/);
    await expect(page.getByRole('heading', { level: 1, name: en.privacy.heading })).toBeVisible();
  });

  test('フッターの利用規約リンクから規約ページへ入り、言語切替もできる', async ({ page }) => {
    await page.goto('/ja/');
    await page.locator('footer').getByRole('link', { name: ja.footer.terms }).click();

    await expect(page).toHaveURL(/\/ja\/terms\/$/);
    await expect(page.getByRole('heading', { level: 1, name: ja.terms.heading })).toBeVisible();

    await page.locator('footer').getByRole('link', { name: ja.footer.langSwitch }).click();
    await expect(page).toHaveURL(/\/en\/terms\/$/);
    await expect(page.getByRole('heading', { level: 1, name: en.terms.heading })).toBeVisible();
  });
});

test.describe('サービス紹介', () => {
  test('Chrome 拡張の紹介が Web 変換の直後に出て、配布ページへ繋がる', async ({ page }) => {
    await page.goto('/ja/');

    const headings = page.locator('[data-lp-sections] article h2');
    await expect(headings.nth(0)).toHaveText(ja.lp.webHeading);
    await expect(headings.nth(1)).toHaveText(ja.lp.extensionHeading);

    const download = page.getByRole('link', { name: ja.lp.extensionLink });
    await expect(download).toHaveAttribute(
      'href',
      'https://github.com/noricha-vr/web-screen-extension/releases/latest'
    );
    await expect(download).toHaveAttribute('target', '_blank');
    await expect(download).toHaveAttribute('rel', 'noopener');

    const image = page.getByRole('img', { name: ja.lp.extensionMediaAlt });
    await expect(image).toHaveAttribute('src', '/lp/extension.png');
    expect((await page.request.get('/lp/extension.png')).status()).toBe(200);
  });

  test('英語トップの拡張の紹介は英語辞書から出る', async ({ page }) => {
    await page.goto('/en/');

    await expect(page.getByRole('heading', { level: 2, name: en.lp.extensionHeading })).toBeVisible();
    await expect(page.getByRole('link', { name: en.lp.extensionLink })).toBeVisible();
  });
});

test.describe('リンクプレビュー', () => {
  const content = (page: Page, selector: string): Promise<string | null> =>
    page.locator(selector).getAttribute('content');

  test('日本語トップに OG タグを出す', async ({ page }) => {
    await page.goto('/ja/');

    expect(await content(page, 'meta[property="og:image"]')).toBe('https://web-screen.net/og.png');
    expect(await content(page, 'meta[property="og:url"]')).toBe('https://web-screen.net/ja/');
    expect(await content(page, 'meta[property="og:title"]')).toBe(ja.meta.title);
    expect(await content(page, 'meta[property="og:description"]')).toBe(ja.meta.description);
    expect(await content(page, 'meta[property="og:image:alt"]')).toBe(ja.meta.imageAlt);
    expect(await content(page, 'meta[property="og:locale"]')).toBe('ja_JP');
    expect(await content(page, 'meta[name="twitter:card"]')).toBe('summary_large_image');
    expect(await content(page, 'meta[property="og:image:width"]')).toBe('1200');
    expect(await content(page, 'meta[property="og:image:height"]')).toBe('630');
  });

  test('英語トップは英語の OG タグを出す', async ({ page }) => {
    await page.goto('/en/');

    expect(await content(page, 'meta[property="og:title"]')).toBe(en.meta.title);
    expect(await content(page, 'meta[property="og:locale"]')).toBe('en_US');
    expect(await content(page, 'meta[property="og:url"]')).toBe('https://web-screen.net/en/');
    expect(await content(page, 'meta[property="og:image"]')).toBe('https://web-screen.net/og.png');
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
