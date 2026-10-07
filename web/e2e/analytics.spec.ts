import { expect, test, type Page } from '@playwright/test';

import { analyticsPageConfig } from '../src/lib/ui/analytics';
import { E2E_FIXTURES } from '../playwright.config';

const GA_MEASUREMENT_ID = 'G-W7D0GRPM2Y';

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

/**
 * 本番ホスト名のままページを開く。計測タグは location.hostname が本番の時だけ動くので、
 * web-screen.net へのリクエストをローカルの Worker へ横流しし、gtag.js 本体は空のスクリプトで
 * 差し替える（外部へ計測を送らない）。外部 CSS は止める。
 * referer はナビゲーションに付けると document.referrer にそのまま入る。
 */
async function openAsProduction(page: Page, path: string, referer: string): Promise<unknown[]> {
  const { baseURL } = test.info().project.use;
  await page.route('https://web-screen.net/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${baseURL}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  await page.route(/googletagmanager\.com/, (route) =>
    route.fulfill({ contentType: 'text/javascript', body: '' })
  );
  await page.route(/cdnjs\.cloudflare\.com/, (route) => route.abort());
  await page.goto(`${PRODUCTION_ORIGIN}${path}`, { referer });
  return page.evaluate(() => {
    const layer = (window as unknown as { dataLayer?: ArrayLike<unknown>[] }).dataLayer ?? [];
    const config = layer.map((call) => Array.from(call)).find((call) => call[0] === 'config');
    return config ?? [];
  });
}

const PRODUCTION_ORIGIN = 'https://web-screen.net';

for (const { title, path, referer } of [
  // #278: 外部 referrer を捨てていたため、検索流入が全部 Direct に計上されていた。
  { title: '検索エンジン', path: '/ja/web/', referer: 'https://www.google.com/search?q=x' },
  { title: '公開IDを含む同一origin', path: '/ja/', referer: `${PRODUCTION_ORIGIN}/Ab12Cd34Ef56/` },
  { title: '同一originのquery付き', path: '/en/', referer: `${PRODUCTION_ORIGIN}/ja/?short-id=Secret123456` },
  // utm の値に公開 ID を入れられるため、キャンペーン用の query も送らない。
  { title: 'utm付きの着地', path: '/ja/?utm_campaign=Ab12Cd34Ef56&stream-id=Secret123456', referer: 'https://t.co/abc' },
]) {
  test(`GA4初期設定（${title}）はanalyticsPageConfigと同じ値を送る`, async ({ page }) => {
    // インラインスクリプトは analyticsPageConfig の写しなので、実ブラウザの dataLayer で一致を見る。
    const config = await openAsProduction(page, path, referer);
    const url = new URL(path, PRODUCTION_ORIGIN);
    const expected = analyticsPageConfig({ origin: url.origin, pathname: url.pathname }, referer);

    expect(config).toEqual(['config', GA_MEASUREMENT_ID, expected]);
  });
}

test('検索エンジンからの流入はoriginだけをpage_referrerに送る', async ({ page }) => {
  const config = await openAsProduction(page, '/ja/web/', 'https://www.google.com/search?q=x');

  expect(config[2]).toEqual({
    page_location: 'https://web-screen.net/ja/web/',
    page_referrer: 'https://www.google.com/',
  });
});

test('本番ホストでは計測タグを挿入しつつcross-origin isolationを保つ', async ({ page }) => {
  // localhost ではホストガードでタグが入らないため、本番ホスト扱いで共存を確かめる（#257）。
  await openAsProduction(page, '/ja/', '');

  await expect(page.locator('script[src*="googletagmanager.com/gtag/js"]')).toHaveCount(1);
  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
});

test('計測タグを足しても cross-origin isolation は維持される', async ({ page }) => {
  // FFmpeg.wasm の SharedArrayBuffer が動く前提そのもの。外部スクリプトの追加で
  // COEP を緩めると、ヘッダーのテストは通ったまま変換だけが壊れる。
  await page.goto('/ja/');

  expect(await page.evaluate(() => window.crossOriginIsolated)).toBe(true);
  expect(await page.evaluate(() => typeof SharedArrayBuffer)).toBe('function');
});
