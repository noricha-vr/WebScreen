import { expect, test } from '@playwright/test';

// public/_redirects の転送規則と、言語振り分けページ（src/pages/{name}.astro）の挙動を
// ビルド済み Worker（wrangler dev）越しに検証する。_redirects は Cloudflare の Static Assets が
// 実行時に解釈するため、ファイルの中身を読むだけでは「実際に転送されるか」を確認できない。

/** 新版に用途別ページがある旧 URL。言語なしは Accept-Language で振り分ける。 */
const USE_CASE_PATHS = ['web', 'pdf', 'image', 'screen-share'] as const;

/** 対応する単独ページが無く、言語トップへ寄せる旧 URL。 */
const TOP_FALLBACK_PATHS = ['history', 'github'] as const;

/** 機能自体が無く、用途がいちばん近い screen-share へ寄せる旧 URL。 */
const SCREEN_SHARE_ALIASES = ['recording', 'streaming'] as const;

const LOCALES = ['ja', 'en'] as const;

test.describe('言語なしの旧 URL（router/main.py）', () => {
  for (const path of USE_CASE_PATHS) {
    test(`/${path}/ は Accept-Language を見て /{lang}/${path}/ へ振り分ける`, async ({
      request,
    }) => {
      // _redirects では言語を判定できないので、ここだけ Worker で実行している。
      // 用途（${path}）を保ったまま言語だけ決めるのが目的。
      const response = await request.get(`/${path}/`, {
        headers: { 'accept-language': 'en-US,en;q=0.9' },
        maxRedirects: 0,
      });

      expect(response.status()).toBe(302);
      expect(response.headers()['location']).toBe(`/en/${path}/`);
    });
  }

  test('/web/ は日本語のブラウザなら /ja/web/ へ送る', async ({ request }) => {
    const response = await request.get('/web/', {
      headers: { 'accept-language': 'ja,en-US;q=0.9' },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(302);
    expect(response.headers()['location']).toBe('/ja/web/');
  });

  for (const path of SCREEN_SHARE_ALIASES) {
    test(`/${path}/ は /screen-share/ へ 301 で転送される`, async ({ request }) => {
      const response = await request.get(`/${path}/`, { maxRedirects: 0 });

      expect(response.status()).toBe(301);
      expect(response.headers()['location']).toBe('/screen-share/');
    });
  }

  test('/record-screen/ は /screen-share/ へ 301 で転送される', async ({ request }) => {
    // 旧版に言語付きの対応 URL が無く、/{lang}/recording/ へ寄せていた URL。
    const response = await request.get('/record-screen/', { maxRedirects: 0 });

    expect(response.status()).toBe(301);
    expect(response.headers()['location']).toBe('/screen-share/');
  });

  for (const path of TOP_FALLBACK_PATHS) {
    test(`/${path}/ は / へ 301 で転送される`, async ({ request }) => {
      const response = await request.get(`/${path}/`, { maxRedirects: 0 });

      expect(response.status()).toBe(301);
      expect(response.headers()['location']).toBe('/');
    });
  }

  test('転送先の / は Accept-Language で言語トップへ振り分ける', async ({ request }) => {
    // 言語なし URL の 2 ホップ目。ここが動かないと旧 URL の利用者がトップに辿り着けない。
    const response = await request.get('/', {
      headers: { 'accept-language': 'en-US,en;q=0.9' },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(302);
    expect(response.headers()['location']).toBe('/en/');
  });
});

test.describe('言語付きの旧 URL（router/main_page.py）', () => {
  for (const locale of LOCALES) {
    for (const path of USE_CASE_PATHS) {
      test(`/${locale}/${path}/ は転送せず実ページを返す`, async ({ request }) => {
        // 用途別ページを新設したので転送行を消した。ここが 301 に戻ったら、
        // _redirects の行が実ページより優先されて新ページに到達できていない。
        const response = await request.get(`/${locale}/${path}/`, { maxRedirects: 0 });

        expect(response.status()).toBe(200);
      });
    }

    for (const path of SCREEN_SHARE_ALIASES) {
      test(`/${locale}/${path}/ は /${locale}/screen-share/ へ 301 で転送される`, async ({
        request,
      }) => {
        // 用途が一致するページへ 1 対 1 で送る（言語トップへの多対一だと評価を引き継がない）。
        const response = await request.get(`/${locale}/${path}/`, { maxRedirects: 0 });

        expect(response.status()).toBe(301);
        expect(response.headers()['location']).toBe(`/${locale}/screen-share/`);
      });
    }

    for (const path of TOP_FALLBACK_PATHS) {
      test(`/${locale}/${path}/ は /${locale}/ へ 301 で転送される`, async ({ request }) => {
        // 被リンクを引き継ぐため 302（_redirects の既定）ではなく 301 であること。
        const response = await request.get(`/${locale}/${path}/`, { maxRedirects: 0 });

        expect(response.status()).toBe(301);
        expect(response.headers()['location']).toBe(`/${locale}/`);
      });
    }
  }
});

test('未対応の言語は転送せずそのまま 404 にする', async ({ request }) => {
  // `/:lang/history/` のプレースホルダ記法を使うと `/fr/history/` → `/fr/`（404）と 2 ホップする。
  // ja / en を明示列挙しているので、未対応言語は転送されずに終わるのが正。
  const response = await request.get('/fr/history/', { maxRedirects: 0 });

  expect(response.status()).toBe(404);
});

test('未対応の言語では用途別ページも 404 にする', async ({ request }) => {
  const response = await request.get('/fr/web/', { maxRedirects: 0 });

  expect(response.status()).toBe(404);
});

for (const locale of LOCALES) {
  test(`/${locale}/privacy は末尾スラッシュ付きへ 301 で転送される`, async ({ request }) => {
    // 旧版の privacy は末尾スラッシュ無し。Static Assets の自動正規化に任せると 307 になり
    // 被リンクが継承されないので、_redirects で 301 を明示している（この差を固定する）。
    const response = await request.get(`/${locale}/privacy`, { maxRedirects: 0 });

    expect(response.status()).toBe(301);
    expect(response.headers()['location']).toBe(`/${locale}/privacy/`);
  });
}
