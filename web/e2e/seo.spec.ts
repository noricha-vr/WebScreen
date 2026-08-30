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

test.describe('用途別ページのメタ情報', () => {
  /** sitemap に載せた用途別ページ（ja / en）。パンくずと description を持つのはこの 8 本だけ。 */
  const USE_CASE_PATHS = [
    '/ja/web/',
    '/ja/screen-share/',
    '/ja/image/',
    '/ja/pdf/',
    '/en/web/',
    '/en/screen-share/',
    '/en/image/',
    '/en/pdf/',
  ] as const;

  /** ページの JSON-LD を 1 つ取り出す（無ければ null）。 */
  async function fetchJsonLd(request: import('@playwright/test').APIRequestContext, path: string) {
    const html = await (await request.get(path)).text();
    const matched = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
    return matched === null ? null : JSON.parse(matched[1]!);
  }

  for (const path of USE_CASE_PATHS) {
    test(`${path} のパンくずが言語トップから自分自身までを絶対 URL で並べる`, async ({
      request,
    }) => {
      const jsonLd = await fetchJsonLd(request, path);
      const lang = path.startsWith('/en/') ? 'en' : 'ja';

      expect(jsonLd).not.toBeNull();
      expect(jsonLd['@type']).toBe('BreadcrumbList');

      const items = jsonLd.itemListElement;
      expect(items).toHaveLength(2);

      // position は 1 始まり（0 始まりだと Google が無効として扱う）。
      expect(items.map((item: { position: number }) => item.position)).toEqual([1, 2]);
      // 相対 URL では解決できないので、必ず本番オリジンの絶対 URL にする。
      expect(items[0].item).toBe(`https://web-screen.net/${lang}/`);
      expect(items[1].item).toBe(`https://web-screen.net${path}`);
      for (const item of items) {
        expect(item.name.length).toBeGreaterThan(0);
      }
    });

    test(`${path} の description が本文の導入文の流用に戻っていない`, async ({ request }) => {
      // lead を description に流用していた頃は 100 文字前後あり、SERP で切れていた。
      const html = await (await request.get(path)).text();
      const matched = /<meta name="description" content="([^"]*)"/.exec(html);

      expect(matched).not.toBeNull();
      const description = matched![1]!;

      expect(description.length).toBeGreaterThan(0);
      expect(description.length).toBeLessThanOrEqual(160);

      // 本文の導入文（lead）をそのまま流し込んでいないこと。meta タグ（description と
      // og:description）を取り除いた残りに同じ文字列が出るなら、本文からの流用を意味する。
      const withoutMeta = html.replace(/<meta\b[^>]*>/g, '');
      expect(withoutMeta).not.toContain(description);
    });
  }

  // パンくずを持たないページに出すと、階層の無いところに階層を主張することになる。
  for (const path of ['/ja/', '/en/', '/ja/privacy/'] as const) {
    test(`${path} にはパンくずを出さない`, async ({ request }) => {
      expect(await fetchJsonLd(request, path)).toBeNull();
    });
  }
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
