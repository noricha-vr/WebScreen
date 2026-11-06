import { expect, test } from '@playwright/test';

import en from '../src/i18n/en.json' with { type: 'json' };
import ja from '../src/i18n/ja.json' with { type: 'json' };

for (const [locale, dictionary] of [['ja', ja], ['en', en]] as const) {
  test(`${locale}: 設定を開閉し 2 秒の選択と例を再読み込み後も復元する`, async ({ page }, testInfo) => {
    await page.route('**/api/me/', (route) => route.fulfill({
      contentType: 'application/json', body: JSON.stringify({ name: 'tester' }),
    }));
    if (locale === 'en') await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${locale}/`);
    const panel = page.locator('[data-convert-panel]');
    const settings = panel.locator('details');
    const summary = settings.locator('summary');
    const group = settings.getByRole('radiogroup', { name: dictionary.convert.secondsPerFrameLabel });
    const oneSecond = group.getByRole('radio', { name: dictionary.convert.secondsOption.replace('{seconds}', '1'), exact: true });
    const twoSeconds = group.getByRole('radio', { name: dictionary.convert.secondsOption.replace('{seconds}', '2'), exact: true });
    await expect(settings).not.toHaveAttribute('open');
    await expect(summary).toHaveText(dictionary.convert.settingsSummary.replace('{seconds}', '1'));
    await expect(group).toBeHidden();
    await summary.click();
    await expect(group).toBeVisible();
    await expect(oneSecond).toBeChecked();
    // sr-only の radio はキーボードからも変更できる。
    await oneSecond.focus();
    await oneSecond.press('ArrowRight');
    await expect(twoSeconds).toBeChecked();
    await expect(settings.locator('[data-settings-example-seconds]')).toHaveText('24');
    await expect(summary).toHaveText(dictionary.convert.settingsSummary.replace('{seconds}', '2'));
    await summary.click();
    await expect(group).toBeHidden();
    await page.reload();
    await expect(summary).toHaveText(dictionary.convert.settingsSummary.replace('{seconds}', '2'));
    await summary.click();
    await expect(twoSeconds).toBeChecked();
    await expect(settings.locator('p').last()).toHaveText(dictionary.convert.durationExample.replace('{seconds}', '24'));
    await expect(page.locator('[data-dropzone]')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`settings-${locale}.png`), fullPage: true });
    // 1 秒にも戻せて、その選択が保存される。
    await group.getByText(dictionary.convert.secondsOption.replace('{seconds}', '1'), { exact: true }).click();
    await page.reload();
    await expect(summary).toHaveText(dictionary.convert.settingsSummary.replace('{seconds}', '1'));
  });
}

test('localStorage が使えなくても設定と変換の入口が動く', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', { get() { throw new Error('SecurityError'); } });
  });
  await page.route('**/api/me/', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ name: 'tester' }),
  }));
  await page.goto('/ja/');
  const panel = page.locator('[data-convert-panel]');
  await panel.locator('summary').click();
  await panel.getByText('2 秒', { exact: true }).click();
  await expect(panel.locator('[data-settings-summary]')).toHaveText(ja.convert.settingsSummary.replace('{seconds}', '2'));
  await expect(panel.locator('[data-settings-example-seconds]')).toHaveText('24');
  await panel.locator('[data-file-input]').setInputFiles({ name: 'unsupported.txt', mimeType: 'text/plain', buffer: Buffer.from('text') });
  await expect(panel).toHaveAttribute('data-phase', 'error');
  await page.reload();
  await expect(panel.locator('[data-settings-summary]')).toHaveText(ja.convert.settingsSummary.replace('{seconds}', '1'));
});
