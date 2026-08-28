import { expect, test, type Locator, type Page } from '@playwright/test';
import { join } from 'node:path';

// Playwright は Node で直接実行するため、JSON には import 属性が要る（Vite は不要）
import en from '../src/i18n/en.json' with { type: 'json' };
import ja from '../src/i18n/ja.json' with { type: 'json' };
import { E2E_FIXTURES } from '../playwright.config';
import { MAX_PINNED_MOVIES } from '../src/lib/services/quota';
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

/** 画面上の位置を比べるための矩形（見えない要素は取れないので失敗させる）。 */
async function boxOf(
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('要素が表示されていない');
  return box;
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

test.describe('所有者の操作', () => {
  test('タイトル → URL → 動画 → 保管期限 の順に並ぶ', async ({ page, context }) => {
    await signIn(context, E2E_FIXTURES.ownerId);
    await page.goto(`/${E2E_FIXTURES.readyShortId}/`);

    // VRChat に貼る URL を動画本体より先に見せ、保管期限と操作は動画の下へ置く
    const positions = [
      await boxOf(page.getByRole('heading', { level: 1 })),
      await boxOf(page.getByText(ja.preview.urlLabel, { exact: true })),
      await boxOf(page.locator('[data-preview-url]')),
      await boxOf(page.locator('[data-preview-video]')),
      await boxOf(page.getByText(ja.preview.expiry)),
    ].map((box) => box.y);

    expect(positions).toEqual([...positions].sort((a, b) => a - b));

    // 操作は保管期限と同じ行（動画より下）に並ぶ
    const video = await boxOf(page.locator('[data-preview-video]'));
    for (const control of [
      page.getByRole('link', { name: ja.actions.download }),
      page.getByRole('button', { name: ja.actions.delete }),
    ]) {
      expect((await boxOf(control)).y).toBeGreaterThan(video.y + video.height);
    }
  });

  test('URL 入力に可視の見出しが結び付いている', async ({ page, context }) => {
    await signIn(context, E2E_FIXTURES.ownerId);
    await page.goto(`/${E2E_FIXTURES.readyShortId}/`);

    // 読み上げ用の aria-label ではなく、画面に見える label で用途を伝える
    // （getByLabel は aria-label でも通るので for / id の結び付きを直接見る）
    await expect(page.locator('label[for="preview-url"]')).toHaveText(ja.preview.urlLabel);
    await expect(page.locator('input#preview-url')).toHaveAttribute('data-preview-url', '');
  });

  test('ピン留めの失敗表示がツールチップに隠れない', async ({ page, context }) => {
    await signIn(context, E2E_FIXTURES.ownerId);
    await page.goto(`/${E2E_FIXTURES.readyShortId}/`);

    // 失敗表示は上限超過や通信断でしか出ないため、重なりだけを見るために直接可視化する
    await page.locator('[data-pin-failed]').evaluate((alert) => {
      alert.textContent = 'x';
      alert.removeAttribute('hidden');
    });
    await page.getByRole('button', { name: ja.preview.pin }).hover();

    const alertBox = await boxOf(page.locator('[data-pin-failed]'));
    const hint = await boxOf(page.locator('[data-preview] [data-tooltip]'));
    expect(hint.y).toBeGreaterThanOrEqual(alertBox.y + alertBox.height);
  });

  test('ピン留めボタンは保管期限の右にあり、ホバーで保管の説明を出す', async ({ page, context }) => {
    await signIn(context, E2E_FIXTURES.ownerId);
    await page.goto(`/${E2E_FIXTURES.readyShortId}/`);

    const expiry = await boxOf(page.getByText(ja.preview.expiry));
    const pinButton = page.getByRole('button', { name: ja.preview.pin });
    const pin = await boxOf(pinButton);

    // 同じ行の右側（期限テキストとの上下差はボタンのパディング分に収まる）
    expect(pin.x).toBeGreaterThan(expiry.x);
    expect(Math.abs(pin.y + pin.height / 2 - (expiry.y + expiry.height / 2))).toBeLessThan(8);

    // 説明文は常時表示せず、ホバーした時だけ出す
    const hint = page.locator('[data-preview] [data-tooltip]');
    await expect(hint).toBeHidden();
    await pinButton.hover();
    await expect(hint).toBeVisible();
    await expect(hint).toHaveText(
      ja.preview.pinHint.replace('{count}', String(MAX_PINNED_MOVIES))
    );

    // フェード途中で撮らないようトランジションを終端まで進める
    await page.screenshot({ path: screenshotPath('05-preview-pin-tooltip'), animations: 'disabled' });
  });

  test('狭い画面でもツールチップが画面内に収まる', async ({ page, context }) => {
    await signIn(context, E2E_FIXTURES.ownerId);
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(`/${E2E_FIXTURES.pinnedShortId}/`);

    const scrollWidth = (): Promise<number> =>
      page.evaluate(() => document.documentElement.scrollWidth);
    const before = await scrollWidth();

    await page.getByRole('button', { name: ja.preview.unpin }).hover();
    const hint = await boxOf(page.locator('[data-preview] [data-tooltip]'));

    expect(hint.x).toBeGreaterThanOrEqual(0);
    expect(hint.x + hint.width).toBeLessThanOrEqual(320);
    // ツールチップが新たな横スクロールを作らないこと
    expect(await scrollWidth()).toBe(before);
  });

  test('キーボードでフォーカスしてもツールチップが出る', async ({ page, context }) => {
    await signIn(context, E2E_FIXTURES.ownerId);
    await page.goto(`/${E2E_FIXTURES.readyShortId}/`);

    const hint = page.locator('[data-preview] [data-tooltip]');
    await page.getByRole('button', { name: ja.preview.pin }).focus();
    await expect(hint).toBeVisible();

    // 上のコンテンツを覆ったままにしない（WCAG 1.4.13 Dismissible）
    await page.keyboard.press('Escape');
    await expect(hint).toBeHidden();
  });

  test('ピン留め中はボタンが解除の操作に変わる', async ({ page, context }) => {
    await signIn(context, E2E_FIXTURES.ownerId);
    await page.goto(`/${E2E_FIXTURES.pinnedShortId}/`);

    await expect(page.getByRole('button', { name: ja.preview.unpin })).toBeVisible();
    await expect(page.getByRole('button', { name: ja.preview.pin })).toHaveCount(0);

    await page.screenshot({ path: screenshotPath('06-preview-pinned') });
  });

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

  test('長すぎるファイル名は保存せず、文字数入りの理由を表示する', async ({ page, context }) => {
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
    const longName = `${'あ'.repeat(256)}.mp4`;
    await input.fill(longName);
    await input.press('Enter');

    const expected = ja.preview.renameTooLong
      .replace('{count}', String(longName.length))
      .replace('{max}', '255');
    await expect(page.locator('[data-rename-failed]')).toHaveText(expected);
    await expect(input).toBeVisible();
    expect(patchRequested).toBe(false);
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
