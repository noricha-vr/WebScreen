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

test.describe('noindex', () => {
  test('プレビューページは検索結果に載せない', async ({ request }) => {
    const response = await request.get(`/${E2E_FIXTURES.readyShortId}/`);

    expect(response.status()).toBe(200);
    expect(await response.text()).toContain('name="robots" content="noindex, nofollow"');
  });

  test('通常ページには noindex を付けない', async ({ request }) => {
    // 全ページに付けてしまうと検索流入が消えるので、既定が false であることを固定する。
    const response = await request.get('/ja/');

    expect(await response.text()).not.toContain('noindex');
  });
});
