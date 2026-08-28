import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// Playwright は Node で直接実行するため、JSON には import 属性が要る（Vite は不要）
import en from '../src/i18n/en.json' with { type: 'json' };
import ja from '../src/i18n/ja.json' with { type: 'json' };
import { E2E_FIXTURES } from '../playwright.config';
import { signIn as signInAsOwner } from './session';
import { signIn as signInWithSessionCookie } from './session';
import { SESSION_COOKIE_NAME } from '../src/lib/contracts/session';

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
    await page.locator('footer').getByRole('link', { name: ja.footer.langSwitch }).click();

    await expect(page).toHaveURL(/\/en\/privacy\/$/);
    await expect(page.getByRole('heading', { level: 1, name: en.privacy.heading })).toBeVisible();
  });
});

test.describe('リンクプレビュー', () => {
  const content = (page: Page, selector: string): Promise<string | null> =>
    page.locator(selector).getAttribute('content');

  test('日本語トップに OG タグと配信中の画像を出す', async ({ page, request }) => {
    await page.goto('/ja/');

    // 絶対 URL であること。相対だとクローラが解決できず画像が出ない
    expect(await content(page, 'meta[property="og:image"]')).toBe('https://web-screen.net/og.png');
    expect(await content(page, 'meta[property="og:url"]')).toBe('https://web-screen.net/ja/');
    expect(await content(page, 'meta[property="og:title"]')).toBe(ja.meta.title);
    expect(await content(page, 'meta[property="og:description"]')).toBe(ja.meta.description);
    expect(await content(page, 'meta[property="og:image:alt"]')).toBe(ja.meta.imageAlt);
    expect(await content(page, 'meta[property="og:locale"]')).toBe('ja_JP');
    expect(await content(page, 'meta[name="twitter:card"]')).toBe('summary_large_image');

    // 宣言した実寸と配信物が食い違うと、縮小表示や枠ズレになる
    expect(await content(page, 'meta[property="og:image:width"]')).toBe('1200');
    expect(await content(page, 'meta[property="og:image:height"]')).toBe('630');

    const image = await request.get('/og.png');
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toContain('image/png');
  });

  test('英語トップは英語の OG タグを出す', async ({ page }) => {
    await page.goto('/en/');

    expect(await content(page, 'meta[property="og:title"]')).toBe(en.meta.title);
    expect(await content(page, 'meta[property="og:locale"]')).toBe('en_US');
    expect(await content(page, 'meta[property="og:url"]')).toBe('https://web-screen.net/en/');
    // 画像は 1 枚を共用する（言語別に作らない）
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

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
);

async function mockUploadEndpoints(page: Page, shortId = 'Ab12Cd34Ef56'): Promise<void> {
  const publicUrl = `https://cdn.test/movies/${shortId}.mp4`;
  await page.route('**/api/uploads/presign/', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        shortId,
        uploadUrl: 'https://upload.test/r2-upload',
        publicUrl,
      }),
    })
  );
  await page.route('**/api/uploads/commit/', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        shortId,
        publicUrl,
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

    await expect(page.locator('[data-history-menu] summary', { hasText: ja.nav.history })).toBeVisible();
    // 名前は sr-only なので、見えるアカウント表示はアバター（頭文字バッジ）とログアウトの 2 つ
    await expect(page.locator('header [data-viewer-initial]')).toBeVisible();
    await expect(page.getByRole('button', { name: ja.nav.logout })).toBeVisible();
    await expect(page.getByRole('link', { name: ja.hero.cta })).toBeHidden();
    await expect(page.getByText(ja.convert.dropzoneTitle)).toBeVisible();
  });

  // ログアウトが 204 を返していた頃はブラウザが遷移せず、押しても何も起きなかった。
  // 実セッション Cookie で入る（/api/me/ をモックするとログアウト後も member を返してしまう）。
  test('ログアウトすると未ログイン表示に戻り、セッション Cookie が消える', async ({
    page,
    context,
  }) => {
    await signInWithSessionCookie(context, E2E_FIXTURES.ownerId);
    await page.goto('/ja/');

    const header = page.locator('header');
    const logout = header.getByRole('button', { name: ja.nav.logout });
    await expect(logout).toBeVisible();

    const logoutResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/auth/logout/') && response.request().method() === 'POST'
    );
    await logout.click();
    expect((await logoutResponse).status()).toBe(303);

    await expect(header.getByRole('link', { name: ja.nav.login })).toBeVisible();
    await expect(logout).toBeHidden();

    const session = (await context.cookies()).find(
      (cookie) => cookie.name === SESSION_COOKIE_NAME
    );
    expect(session).toBeUndefined();
  });

  test('小さな画像2枚を MP4 に変換し、プレビューで動画 URL を自動コピーする', async ({ page, context }) => {
    test.setTimeout(180_000);
    await signIn(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await mockUploadEndpoints(page, E2E_FIXTURES.readyShortId);
    await page.goto('/ja/');

    const panel = page.locator('[data-convert-panel]');
    const uploadRequest = page.waitForRequest('https://upload.test/r2-upload');
    const presignRequest = page.waitForRequest('**/api/uploads/presign/');
    await panel.locator('[data-file-input]').setInputFiles([
      { name: 'first.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG },
      { name: 'second.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG },
    ]);

    // ファイル変換中はラベルが「選択中のファイル」+ 先頭ファイル名になる
    await expect(panel.locator('[data-source-label]')).toHaveText(ja.convert.selectedFile);
    await expect(panel.locator('[data-source-name]')).toHaveText('first.png');

    // 複数枚は「先頭ファイル名 + 残り枚数」で保存される（/ja/ なので日本語の接尾辞）
    expect((await presignRequest).postDataJSON().filename).toBe(
      `first ${ja.convert.batchNameSuffix.replace('{count}', '1')}.mp4`
    );

    const request = await uploadRequest;
    expect(request.headers()['content-type']).toBe('video/mp4');
    const body = request.postDataBuffer();
    expect(body).not.toBeNull();
    expect(body!.subarray(4, 8).toString('ascii')).toBe('ftyp');

    await expect(page).toHaveURL(new RegExp(`/${E2E_FIXTURES.readyShortId}/$`), {
      timeout: 120_000,
    });
    const preview = page.locator('[data-preview]');
    await expect(preview).toHaveAttribute('data-copied', 'true');
    const previewUrl = await preview.locator('[data-preview-url]').inputValue();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(previewUrl);

    await page.goBack();
    const restoredPanel = page.locator('[data-convert-panel]');
    await expect(restoredPanel.getByText(ja.convert.dropzoneTitle)).toBeVisible();
    await restoredPanel.locator('[data-file-input]').setInputFiles({
      name: 'archive.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('PK'),
    });
    await expect(restoredPanel).toHaveAttribute('data-phase', 'error');
  });

  // 実ファイルをブラウザ内変換パイプライン（PDF.js / FFmpeg.wasm）に通し、
  // 出力 mp4 が faststart mp4（先頭ボックスが ftyp）であることを確認する。
  // PDF 入力経路が実データで mp4 を生成できることの機械実証。
  for (const c of [
    { label: 'PDF（3ページ）', file: 'sample-3page.pdf', mimeType: 'application/pdf' },
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

      await expect(page).toHaveURL(/\/Ab12Cd34Ef56\/$/, { timeout: 120_000 });
    });
  }

  test('URL からのウェブページ変換：capture の画像群を MP4 にして ftyp を確認する', async ({ page }) => {
    test.setTimeout(180_000);
    await signIn(page);
    await mockUploadEndpoints(page);
    // web-capture プロキシは撮影順の画像 URL 配列を返す（順序が動画のスクロール順になる）
    const shots = ['0001', '0002', '0003'].map((n) => `https://shots.test/cap/${n}.png`);
    await page.route('**/api/capture/', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ images: shots, totalImages: shots.length }),
      })
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
    const presignRequest = page.waitForRequest('**/api/uploads/presign/');
    await panel.locator('[data-url-input]').fill('https://example.com/');
    await panel.locator('[data-url-form] button[type="submit"]').click();

    // URL 変換中はラベルが「変換する URL」+ 入力 URL に切り替わる
    await expect(panel.locator('[data-source-label]')).toHaveText(ja.convert.sourceUrl);
    await expect(panel.locator('[data-source-name]')).toHaveText('https://example.com/');

    // 変換元の URL から名前を作る（ルート直下なのでホスト名だけ）
    expect((await presignRequest).postDataJSON().filename).toBe('example.com.mp4');

    const request = await uploadRequest;
    expect(request.headers()['content-type']).toBe('video/mp4');
    const body = request.postDataBuffer();
    expect(body).not.toBeNull();
    expect(body!.subarray(4, 8).toString('ascii')).toBe('ftyp');
    await expect(page).toHaveURL(/\/Ab12Cd34Ef56\/$/, { timeout: 120_000 });
  });

  test('アップロードに失敗したら予約した動画を実際に取り消す', async ({ page, context }) => {
    // presign を通った時点で pending の行が予約される。ここで失敗を放置すると
    // 誰も failed へ落とさないまま履歴に「処理中」として残り続けていた。
    test.setTimeout(180_000);
    // 実セッションを張る（DELETE が 401 でも通ってしまうテストにしない）
    await signInAsOwner(context, E2E_FIXTURES.ownerId);
    await signIn(page);
    // seed 済みの pending 行を予約結果に見立てる
    await mockUploadEndpoints(page, E2E_FIXTURES.pendingShortId);
    // R2 への PUT だけを失敗させる（presign は成功済み = 予約が残る状況を作る）
    await page.route('https://upload.test/r2-upload', (route) => route.fulfill({ status: 500 }));

    const deleteResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().includes(`/api/movies/${E2E_FIXTURES.pendingShortId}/`)
    );

    await page.goto('/ja/');
    await page
      .locator('[data-convert-panel] [data-file-input]')
      .setInputFiles([{ name: 'first.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG }]);

    // 送信されたことではなく、サーバーが受理したことを確認する
    expect((await deleteResponse).status()).toBe(204);
    await expect(page.locator('[data-convert-panel] [data-file-error]')).toBeVisible();

    // 対象が実際に消えている（pending は元から公開されないので、2 回目の DELETE が 404）
    // Astro の origin チェック（CSRF 保護）が効いているため Origin を明示する
    const second = await context.request.delete(`/api/movies/${E2E_FIXTURES.pendingShortId}/`, {
      headers: { Origin: new URL(page.url()).origin },
    });
    expect(second.status()).toBe(404);
  });

  test('commit の応答が壊れていても完成した動画は消さない', async ({ page, context }) => {
    // commit が成功して ready になった後に応答だけ失われるケース。ここで取り消すと
    // 完成した動画を失うため、サーバーがエラーを返した時以外は触らない。
    test.setTimeout(180_000);
    await signInAsOwner(context, E2E_FIXTURES.ownerId);
    await signIn(page);
    await mockUploadEndpoints(page, E2E_FIXTURES.pinnedShortId);
    await page.route('**/api/uploads/commit/', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: 'not-json' })
    );

    let deleteSeen = false;
    page.on('request', (req) => {
      if (req.method() === 'DELETE' && req.url().includes('/api/movies/')) deleteSeen = true;
    });

    await page.goto('/ja/');
    await page
      .locator('[data-convert-panel] [data-file-input]')
      .setInputFiles([{ name: 'first.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG }]);

    await expect(page.locator('[data-convert-panel] [data-file-error]')).toBeVisible();
    expect(deleteSeen).toBe(false);
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
    await expect(panel.locator('[data-file-error-message]')).toHaveText(ja.convert.errorUnsupported);
  });

  test('動画 picker と D&D は presign / PUT 前に拒否する', async ({ page }) => {
    let presignCalls = 0;
    let putCalls = 0;
    await signIn(page);
    await page.route('**/api/uploads/presign/', (route) => {
      presignCalls += 1;
      return route.fulfill({ status: 500 });
    });
    await page.route('https://upload.test/**', (route) => {
      putCalls += 1;
      return route.fulfill({ status: 500 });
    });
    await page.goto('/ja/');

    const panel = page.locator('[data-convert-panel]');
    await panel.locator('[data-file-input]').setInputFiles({
      name: 'picker.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70]),
    });
    await expect(panel).toHaveAttribute('data-phase', 'error');
    await expect(panel.locator('[data-file-error-message]')).toHaveText(ja.convert.errorUnsupported);

    await panel.locator('[data-dropzone]').evaluate((dropzone) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70])], 'dropped.mp4', { type: 'video/mp4' }));
      dropzone.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    });
    await expect(panel).toHaveAttribute('data-phase', 'error');
    expect(presignCalls).toBe(0);
    expect(putCalls).toBe(0);
  });

  test('長いページは capture を複数回に分けて取得する', async ({ page }) => {
    // 1 リクエストの上限を超えるページでも、続きを取りに行って全部を動画にする
    test.setTimeout(180_000);
    await signIn(page);
    await mockUploadEndpoints(page);

    const TOTAL = 5;
    const PER_REQUEST = 2;
    const requested: number[] = [];
    await page.route('**/api/capture/', (route) => {
      const startIndex = (route.request().postDataJSON() as { startIndex?: number }).startIndex ?? 0;
      requested.push(startIndex);
      const images = Array.from(
        { length: Math.min(PER_REQUEST, Math.max(TOTAL - startIndex, 0)) },
        (_unused, offset) => `https://shots.test/long/${startIndex + offset + 1}.png`
      );
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ images, totalImages: TOTAL }),
      });
    });

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
      'base64'
    );
    await page.route('https://shots.test/long/*', (route) =>
      route.fulfill({ contentType: 'image/png', body: png })
    );

    const uploadRequest = page.waitForRequest('https://upload.test/r2-upload');
    await page.goto('/ja/');
    const panel = page.locator('[data-convert-panel]');
    await panel.locator('[data-url-input]').fill('https://example.com/very-long');
    await panel.locator('[data-url-form] button[type="submit"]').click();

    const body = (await uploadRequest).postDataBuffer();
    expect(body).not.toBeNull();
    expect(body!.subarray(4, 8).toString('ascii')).toBe('ftyp');
    // 続きの位置を送って 3 回で集め切る
    expect(requested).toEqual([0, 2, 4]);
  });

  test('totalImages を返さない旧 upstream でも変換できる', async ({ page }) => {
    // 段階リリース中やロールバック直後に、返ってきた分で変換を続けられること
    test.setTimeout(180_000);
    await signIn(page);
    await mockUploadEndpoints(page);

    const shots = ['0001', '0002'].map((n) => `https://shots.test/legacy/${n}.png`);
    await page.route('**/api/capture/', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ images: shots }) })
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
      'base64'
    );
    await page.route('https://shots.test/legacy/*', (route) =>
      route.fulfill({ contentType: 'image/png', body: png })
    );

    const uploadRequest = page.waitForRequest('https://upload.test/r2-upload');
    await page.goto('/ja/');
    const panel = page.locator('[data-convert-panel]');
    await panel.locator('[data-url-input]').fill('https://example.com/legacy');
    await panel.locator('[data-url-form] button[type="submit"]').click();

    const body = (await uploadRequest).postDataBuffer();
    expect(body).not.toBeNull();
    expect(body!.subarray(4, 8).toString('ascii')).toBe('ftyp');
  });

  test('非Webページ URL の案内は URL 欄にだけ表示し、下流メッセージを出さない', async ({ page }) => {
    const rawMessage = 'internal upstream detail';
    await signIn(page);
    await page.route('**/api/capture/', (route) =>
      route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({ errorCode: 'PDF_URL_NOT_SUPPORTED', message: rawMessage }),
      })
    );
    await page.goto('/ja/');

    const panel = page.locator('[data-convert-panel]');
    await panel.locator('[data-url-input]').fill('https://example.com/report.pdf');
    await panel.locator('[data-url-form] button[type="submit"]').click();

    await expect(panel.locator('[data-url-error-message]')).toHaveText(ja.convert.errorPdfUrlNotSupported);
    await expect(panel.locator('[data-url-error]')).toBeVisible();
    await expect(panel.locator('[data-file-error]')).toBeHidden();
    await expect(panel.getByText(rawMessage)).toHaveCount(0);
  });
});
