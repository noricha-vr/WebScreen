// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import tailwindcss from '@tailwindcss/vite';

// trailingSlash: 'always' なので API ルートも末尾スラッシュ必須（/api/health/ で叩く）。
// スラッシュ無しの /api/health は 404 になるため、fetch 側の URL も必ず末尾に / を付ける。
export default defineConfig({
  adapter: cloudflare(),
  output: 'static',
  trailingSlash: 'always',
  i18n: {
    // prefixDefaultLocale: true により defaultLocale も含め全ロケールが /{lang}/ 配下になる
    // （既存 FastAPI 版の /ja/ /en/ ルーティングと URL 構造を揃えるため）。
    defaultLocale: 'ja',
    locales: ['ja', 'en'],
    routing: {
      prefixDefaultLocale: true,
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
