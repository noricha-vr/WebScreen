import { expect, test } from '@playwright/test';

// public/_redirects の転送規則を、ビルド済み Worker（wrangler dev）越しに検証する。
// _redirects は Cloudflare の Static Assets が実行時に解釈するため、ファイルの中身を
// 読むだけでは「実際に転送されるか」を確認できない。必ず Worker 経由で見る。

/** 旧 FastAPI 版にあって新版に無い機能別ページ。増減したら public/_redirects と同時に直す。 */
const LEGACY_PATHS = [
  'web',
  'pdf',
  'image',
  'history',
  'recording',
  'streaming',
  'github',
] as const;

const LOCALES = ['ja', 'en'] as const;

test.describe('旧サイトの機能別 URL', () => {
  for (const locale of LOCALES) {
    for (const path of LEGACY_PATHS) {
      test(`/${locale}/${path}/ は /${locale}/ へ 301 で転送される`, async ({ request }) => {
        const response = await request.get(`/${locale}/${path}/`, { maxRedirects: 0 });

        // 被リンクを引き継ぐため 302（_redirects の既定）ではなく 301 であること。
        expect(response.status()).toBe(301);
        expect(response.headers()['location']).toBe(`/${locale}/`);
      });
    }
  }
});

test('未対応の言語は転送せずそのまま 404 にする', async ({ request }) => {
  // `/:lang/web/` のプレースホルダ記法を使うと `/fr/web/` → `/fr/`（404）と 2 ホップする。
  // ja / en を明示列挙しているので、未対応言語は転送されずに終わるのが正。
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
