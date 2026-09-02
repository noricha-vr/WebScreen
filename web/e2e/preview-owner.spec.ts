import { expect, test, type Locator } from '@playwright/test';

// Playwright は Node で直接実行するため、JSON には import 属性が要る（Vite は不要）
import ja from '../src/i18n/ja.json' with { type: 'json' };
import { E2E_FIXTURES } from '../playwright.config';
import { MAX_PINNED_MOVIES } from '../src/lib/services/quota';
import { screenshotPath } from './screenshot';
import { signIn } from './session';

// 所有者としてログインしたときの /{shortId}/ の操作確認（並び順・ピン留め・リネーム・削除）。
// D1 のフィクスチャは playwright.config.ts の webServer が seed.sql で流し込む。

// /{shortId}/ の表示言語は Accept-Language で決まる。Playwright の既定は en-US なので、
// 日本語の文言で確認するために明示する。
test.use({ locale: 'ja-JP', extraHTTPHeaders: { 'Accept-Language': 'ja,en;q=0.8' } });

/** 画面上の位置を比べるための矩形（見えない要素は取れないので失敗させる）。 */
async function boxOf(
  locator: Locator
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('要素が表示されていない');
  return box;
}

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

  test('保管期限を過ぎた動画は pin できず、理由を表示する', async ({ page, context }) => {
    await signIn(context, E2E_FIXTURES.ownerId);
    await page.goto(`/${E2E_FIXTURES.expiredShortId}/`);

    await page.getByRole('button', { name: ja.preview.pin }).click();

    // 上限超過（409）と同じ扱いにすると「10 件まで」と出て理由が伝わらない
    await expect(page.locator('[data-pin-failed]')).toHaveText(ja.preview.pinExpired);
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
    await page.goto(`/${E2E_FIXTURES.renamableShortId}/`);

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
    await page.goto(`/${E2E_FIXTURES.unpinnableShortId}/`);

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
