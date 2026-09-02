import { expect, test } from '@playwright/test';

// Playwright は Node で直接実行するため、JSON には import 属性が要る（Vite は不要）
import en from '../src/i18n/en.json' with { type: 'json' };
import ja from '../src/i18n/ja.json' with { type: 'json' };
import { E2E_FIXTURES } from '../playwright.config';
import { screenshotPath } from './screenshot';

// 公開プレビュー /{shortId}/ の画面確認（表示・ダウンロード・言語・404）。
// 所有者だけの操作は preview-owner.spec.ts、履歴ドロップダウンは history-menu.spec.ts。
// D1 のフィクスチャは playwright.config.ts の webServer が seed.sql で流し込む。

// /{shortId}/ の表示言語は Accept-Language で決まる。Playwright の既定は en-US なので、
// 日本語を確認するテストのために明示する（英語の確認は専用の context を作る）。
test.use({ locale: 'ja-JP', extraHTTPHeaders: { 'Accept-Language': 'ja,en;q=0.8' } });

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

  test('ダウンロードボタンが実体を attachment として返す', async ({ page, request }) => {
    await page.goto(`/${E2E_FIXTURES.readyShortId}/`);

    // 閲覧者（未ログイン）にも出す
    const link = page.getByRole('link', { name: ja.actions.download });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', `/${E2E_FIXTURES.readyShortId}/download/`);

    const response = await request.get(`/${E2E_FIXTURES.readyShortId}/download/`);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toBe('video/mp4');
    // ページと配信ドメインが別オリジンなので、ここで attachment を付ける必要がある
    expect(response.headers()['content-disposition']).toContain('attachment');
    // 表示名は slides.pdf だが、実体は mp4 なので保存名は .mp4 へ正規化する
    expect(response.headers()['content-disposition']).toContain('filename="slides.mp4"');
    expect(response.headers()['x-robots-tag']).toBe('noindex');

    // ヘッダーだけでなく実体が流れていることを確認する
    const body = await response.body();
    expect(body.byteLength).toBeGreaterThan(0);
    expect(body.subarray(4, 8).toString('ascii')).toBe('ftyp');

    // 総量が分かって初めて進捗表示と再開の判断ができる
    expect(response.headers()['content-length']).toBe(String(body.byteLength));
    expect(response.headers()['accept-ranges']).toBe('bytes');
  });

  test('Range 要求には 206 で要求された範囲だけを返す', async ({ request }) => {
    const response = await request.get(`/${E2E_FIXTURES.readyShortId}/download/`, {
      headers: { Range: 'bytes=0-99' },
    });

    expect(response.status()).toBe(206);
    expect(response.headers()['content-range']).toMatch(/^bytes 0-99\/\d+$/);
    expect(response.headers()['content-length']).toBe('100');
    expect(response.headers()['accept-ranges']).toBe('bytes');
    // 再開したダウンロードでも保存名が変わらないこと
    expect(response.headers()['content-disposition']).toContain('filename="slides.mp4"');

    const body = await response.body();
    expect(body.byteLength).toBe(100);
    expect(body.subarray(4, 8).toString('ascii')).toBe('ftyp');
  });

  test('実体と重ならない Range は 416 と総量を返す', async ({ request }) => {
    const response = await request.get(`/${E2E_FIXTURES.readyShortId}/download/`, {
      headers: { Range: 'bytes=99999999-' },
    });

    expect(response.status()).toBe(416);
    // 総量を返さないと、クライアントは範囲を直して要求し直せない
    expect(response.headers()['content-range']).toMatch(/^bytes \*\/\d+$/);
  });

  test('HEAD は Range を無視して 200 と総量だけを返す', async ({ request }) => {
    const size = (await (await request.get(`/${E2E_FIXTURES.readyShortId}/download/`)).body())
      .byteLength;

    const response = await request.head(`/${E2E_FIXTURES.readyShortId}/download/`, {
      headers: { Range: 'bytes=0-99' },
    });

    // RFC 9110 14.2 は GET 以外の Range を無視させる
    expect(response.status()).toBe(200);
    expect(response.headers()['content-range']).toBeUndefined();
    expect(response.headers()['content-length']).toBe(String(size));
    expect(response.headers()['accept-ranges']).toBe('bytes');
    expect(response.headers()['content-disposition']).toContain('filename="slides.mp4"');
    expect((await response.body()).byteLength).toBe(0);
  });

  test('If-Range が実体と一致しなければ全体を返す', async ({ request }) => {
    const response = await request.get(`/${E2E_FIXTURES.readyShortId}/download/`, {
      headers: { Range: 'bytes=0-99', 'If-Range': '"not-the-current-etag"' },
    });

    // 差し替わった実体の一部を継ぎ足すと、壊れたファイルが出来上がる
    expect(response.status()).toBe(200);
    expect(response.headers()['content-range']).toBeUndefined();
    expect((await response.body()).byteLength).toBeGreaterThan(100);
  });

  test('存在しない動画のダウンロードは 404', async ({ request }) => {
    expect((await request.get('/E2EMissing001/download/')).status()).toBe(404);
  });

  test('英語の Accept-Language では英語で出る', async ({ browser }) => {
    // Accept-Language は locale から組み立てられる（extraHTTPHeaders だけでは効かない）
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    await page.goto(`/${E2E_FIXTURES.readyShortId}/`);

    await expect(page.getByRole('button', { name: en.preview.copy })).toBeVisible();
    await expect(page.getByText(ja.preview.expiry)).toHaveCount(0);

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

  test('ピン留め中の動画は 1 年後までの残日数を表示する', async ({ page }) => {
    await page.goto(`/${E2E_FIXTURES.pinnedShortId}/`);

    await expect(
      page.getByText(
        ja.preview.expiresInDays.replace('{days}', String(E2E_FIXTURES.pinnedRemainingDays))
      )
    ).toBeVisible();
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
