import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// Playwright は Node で直接実行するため、JSON には import 属性が要る（Vite は不要）
import en from '../src/i18n/en.json' with { type: 'json' };
import ja from '../src/i18n/ja.json' with { type: 'json' };

const fixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));

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
    await expect(cta).toHaveAttribute('href', '/api/auth/login/');

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

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
);

async function mockUploadEndpoints(page: Page): Promise<void> {
  await page.route('**/api/uploads/presign/', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        shortId: 'Ab12Cd34Ef56',
        uploadUrl: 'https://upload.test/r2-upload',
        publicUrl: 'https://cdn.test/movies/Ab12Cd34Ef56.mp4',
      }),
    })
  );
  await page.route('**/api/uploads/commit/', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        shortId: 'Ab12Cd34Ef56',
        publicUrl: 'https://cdn.test/movies/Ab12Cd34Ef56.mp4',
        sizeBytes: 1024,
        expiresAt: null,
      }),
    })
  );
  await page.route('https://upload.test/r2-upload', (route) => route.fulfill({ status: 200 }));
}

test.describe('ログイン済み', () => {
  test('ヘッダーがアカウント表示に切り替わり変換パネルが出る', async ({ page }) => {
    await signIn(page);
    await page.goto('/ja/');

    await expect(page.getByRole('link', { name: ja.nav.upload })).toBeVisible();
    await expect(page.getByText('noricha')).toBeVisible();
    await expect(page.getByRole('link', { name: ja.hero.cta })).toBeHidden();
    await expect(page.getByText(ja.convert.dropzoneTitle)).toBeVisible();
  });

  test('小さな画像2枚を MP4 に変換し、ftyp を含む成果物をアップロードする', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    await mockUploadEndpoints(page);
    await page.goto('/ja/');

    const panel = page.locator('[data-convert-panel]');
    const uploadRequest = page.waitForRequest('https://upload.test/r2-upload');
    await panel.locator('[data-file-input]').setInputFiles([
      { name: 'first.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG },
      { name: 'second.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG },
    ]);

    const request = await uploadRequest;
    expect(request.headers()['content-type']).toBe('video/mp4');
    const body = request.postDataBuffer();
    expect(body).not.toBeNull();
    expect(body!.subarray(4, 8).toString('ascii')).toBe('ftyp');

    await expect(panel).toHaveAttribute('data-phase', 'done', { timeout: 120_000 });
    const doneBlock = panel.locator('[data-when-phase="done"]');
    await expect(doneBlock.getByText(ja.convert.done)).toBeVisible();
    await expect(doneBlock.locator('[data-result-url]')).toHaveValue(
      'https://cdn.test/movies/Ab12Cd34Ef56.mp4'
    );
    await expect(doneBlock.locator('[data-preview-link]')).toHaveAttribute('href', '/Ab12Cd34Ef56/');

    await page.getByRole('button', { name: ja.convert.copy }).click();
    await expect(page.getByText(ja.convert.copied)).toBeVisible();

    await page.getByRole('button', { name: ja.convert.again }).click();
    await expect(panel).toHaveAttribute('data-phase', 'idle');
  });

  // 実ファイルをブラウザ内変換パイプライン（PDF.js / FFmpeg.wasm）に通し、
  // 出力 mp4 が faststart mp4（先頭ボックスが ftyp）であることを確認する。
  // 画像・PDF・動画の3経路がそれぞれ実データで mp4 を生成できることの機械実証。
  for (const c of [
    { label: 'PDF（3ページ）', file: 'sample-3page.pdf', mimeType: 'application/pdf' },
    { label: '動画ファイル', file: 'sample-clip.mp4', mimeType: 'video/mp4' },
  ]) {
    test(`${c.label}を MP4 に変換し、ftyp を含む成果物をアップロードする`, async ({ page }) => {
      test.setTimeout(180_000);
      await signIn(page);
      await mockUploadEndpoints(page);
      await page.goto('/ja/');

      const panel = page.locator('[data-convert-panel]');
      const uploadRequest = page.waitForRequest('https://upload.test/r2-upload');
      await panel.locator('[data-file-input]').setInputFiles({
        name: c.file,
        mimeType: c.mimeType,
        buffer: fixture(c.file),
      });

      const request = await uploadRequest;
      expect(request.headers()['content-type']).toBe('video/mp4');
      const body = request.postDataBuffer();
      expect(body).not.toBeNull();
      expect(body!.subarray(4, 8).toString('ascii')).toBe('ftyp');

      await expect(panel).toHaveAttribute('data-phase', 'done', { timeout: 120_000 });
      await expect(panel.locator('[data-when-phase="done"]').locator('[data-result-url]')).toHaveValue(
        'https://cdn.test/movies/Ab12Cd34Ef56.mp4'
      );
    });
  }

  test('URL からのウェブページ変換：capture の画像群を MP4 にして ftyp を確認する', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    await mockUploadEndpoints(page);
    // web-capture プロキシは撮影順の画像 URL 配列を返す（順序が動画のスクロール順になる）
    const shots = ['0001', '0002', '0003'].map((n) => `https://shots.test/cap/${n}.png`);
    await page.route('**/api/capture/', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ images: shots }) })
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
      'base64'
    );
    for (const shot of shots) {
      await page.route(shot, (route) => route.fulfill({ contentType: 'image/png', body: png }));
    }
    await page.goto('/ja/');

    const panel = page.locator('[data-convert-panel]');
    const uploadRequest = page.waitForRequest('https://upload.test/r2-upload');
    await panel.locator('[data-url-input]').fill('https://example.com/');
    await panel.locator('[data-url-form] button[type="submit"]').click();

    const request = await uploadRequest;
    expect(request.headers()['content-type']).toBe('video/mp4');
    const body = request.postDataBuffer();
    expect(body).not.toBeNull();
    expect(body!.subarray(4, 8).toString('ascii')).toBe('ftyp');
    await expect(panel).toHaveAttribute('data-phase', 'done', { timeout: 120_000 });
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
});
