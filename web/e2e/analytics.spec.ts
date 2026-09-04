import { expect, test } from '@playwright/test';

import { E2E_FIXTURES } from '../playwright.config';

// GA4 の「送ってはいけない場面で送らない」を固定する。外部ネットワークへ実際に届くかは
// 環境依存なのでここでは見ない（本番ドメインでの疎通確認は切替手順側の責務）。

test('本番ドメイン以外では計測タグを読み込まない', async ({ page }) => {
  // localhost で dataLayer が生えていたら、β Worker や E2E のトラフィックが
  // 本番レポートへ混ざる状態になっている。
  // ホストガードは head のインラインスクリプトで同期的に判定するので、goto の既定
  // （load 待ち）で結果が出ている。networkidle は /api/me/ 等が居るため成立しない。
  await page.goto('/ja/');

  const dataLayer = await page.evaluate(
    () => (window as unknown as { dataLayer?: unknown[] }).dataLayer
  );
  expect(dataLayer).toBeUndefined();

  const gtagScripts = await page.locator('script[src*="googletagmanager.com"]').count();
  expect(gtagScripts).toBe(0);
});

test('プレビューページには計測タグ自体を出力しない', async ({ request }) => {
  // タイトルにアップロード済みファイル名、URL に共有 ID そのものである shortId が入るため、
  // ホスト判定より手前（HTML の出力段階）で落とす。
  const response = await request.get(`/${E2E_FIXTURES.readyShortId}/`);
  const html = await response.text();

  expect(response.status()).toBe(200);
  expect(html).toContain(E2E_FIXTURES.readyFilename);
  expect(html).not.toContain('googletagmanager.com');
});

test('GA4初期設定はpage locationと同一origin referrerのquery/hashを送らない', async ({ request }) => {
  const response = await request.get('/ja/?stream-id=Secret123456');
  const html = await response.text();

  expect(response.status()).toBe(200);
  expect(html).toContain('page_location: location.origin + location.pathname');
  expect(html).toContain('pageReferrer = referrer.origin + referrer.pathname');
  expect(html).toContain("let pageReferrer = ''");
  expect(html).not.toContain('page_location: location.href');
  expect(html).not.toContain('page_referrer: document.referrer');
});

test('計測タグを足しても cross-origin isolation は維持される', async ({ page }) => {
  // FFmpeg.wasm の SharedArrayBuffer が動く前提そのもの。外部スクリプトの追加で
  // COEP を緩めると、ヘッダーのテストは通ったまま変換だけが壊れる。
  await page.goto('/ja/');

  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('function');
});
