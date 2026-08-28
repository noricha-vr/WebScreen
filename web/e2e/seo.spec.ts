import { expect, test } from '@playwright/test';

import { E2E_FIXTURES } from '../playwright.config';

// クローラ向けのファイルとメタタグを、ビルド済み Worker 越しに確認する。
// public/ に置いただけでは配信されるとは限らないため、実際のレスポンスを見る。

test('robots.txt が配信され sitemap の場所を指している', async ({ request }) => {
  const response = await request.get('/robots.txt');

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('text/plain');
  expect(await response.text()).toContain('Sitemap: https://web-screen.net/sitemap.xml');
});

test('sitemap.xml が配信される', async ({ request }) => {
  const response = await request.get('/sitemap.xml');
  const body = await response.text();

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('xml');
  expect(body).toContain('<loc>https://web-screen.net/ja/</loc>');
});

test('favicon.ico が配信される', async ({ request }) => {
  // 旧サイトから引き継いだ ICO。切替でタブのアイコンが消えるのを防ぐ。
  const response = await request.get('/favicon.ico');

  expect(response.status()).toBe(200);
  expect((await response.body()).byteLength).toBeGreaterThan(0);
});

/** PNG の IHDR から実寸を読む（先頭 8 バイトが署名、続く IHDR の 8 バイト目から幅・高さ）。 */
function pngSize(body: Buffer): { width: number; height: number } {
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

test('og.png が宣言どおりの実寸で配信される', async ({ request }) => {
  // meta の値だけ見ても、画像を差し替えた時にズレたことに気づけない
  const response = await request.get('/og.png');
  const body = await response.body();

  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('image/png');
  expect(pngSize(body)).toEqual({ width: 1200, height: 630 });
  // 1MB を超えると取得を諦めるサービスがある
  expect(body.byteLength).toBeLessThan(1_000_000);
});

test.describe('noindex', () => {
  test('プレビューページは検索結果に載せない', async ({ request }) => {
    const response = await request.get(`/${E2E_FIXTURES.readyShortId}/`);

    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('name="robots" content="noindex"');
  });

  test('プレビューページの OG は共有 URL とファイル名を出す（noindex と両立させる）', async ({
    request,
  }) => {
    // 共有先のリンク展開にファイル名が出るのは仕様。noindex は検索結果を制御するだけで、
    // リンク展開を止めるものではない。ここを変える時は「タイトルからも外すのか」まで含めて決める。
    const response = await request.get(`/${E2E_FIXTURES.readyShortId}/`);
    const html = await response.text();

    expect(html).toContain(
      `<meta property="og:url" content="https://web-screen.net/${E2E_FIXTURES.readyShortId}/">`
    );
    expect(html).toContain('property="og:image" content="https://web-screen.net/og.png"');
    expect(html).toContain('name="robots" content="noindex"');
  });

  // 全ページに付けてしまうと検索流入が消える。sitemap に載せた 4 ページすべてで確認する
  // （/ja/ だけ見ていると、privacy や英語版だけ誤って除外された事故に気づけない）。
  const INDEXABLE_PATHS = ['/ja/', '/en/', '/ja/privacy/', '/en/privacy/'] as const;

  for (const path of INDEXABLE_PATHS) {
    test(`${path} には noindex を付けない`, async ({ request }) => {
      const response = await request.get(path);

      expect(response.status()).toBe(200);
      expect(await response.text()).not.toContain('noindex');
      // メタタグを消しただけではヘッダー経由で除外されうるので両方見る。
      expect(response.headers()['x-robots-tag']).toBeUndefined();
    });
  }
});
