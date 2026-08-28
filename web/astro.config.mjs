// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

// trailingSlash: 'always' なので API ルートも末尾スラッシュ必須（/api/health/ で叩く）。
// スラッシュ無しの /api/health は 404 になるため、fetch 側の URL も必ず末尾に / を付ける。
export default defineConfig({
  // OG の画像・URL は絶対パスでないとクローラが解決できないため、正となるオリジンをここに置く。
  site: 'https://web-screen.net',
  adapter: cloudflare(),
  output: 'static',
  trailingSlash: 'always',
  i18n: {
    // ページは物理的に /ja/ /en/ 配下に置く（既存 FastAPI 版と URL 構造を揃えるため）。
    //
    // routing は 'manual'。prefixDefaultLocale: true（= pathname-prefix-always-no-redirect）だと
    // Astro の i18n ミドルウェアが「ロケール接頭辞の無いページ URL」を無条件に 404 にするため、
    // 公開プレビュー /{shortId}/ が到達不能になる（astro/dist/i18n/router.js の
    // matchPrefixAlwaysNoRedirect）。ロケール判定は src/pages/index.astro の
    // Accept-Language 振り分けで自前に行っており、ミドルウェアに任せている処理は無い。
    defaultLocale: 'ja',
    locales: ['ja', 'en'],
    routing: 'manual',
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
