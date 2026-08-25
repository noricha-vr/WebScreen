# web/ — WebScreen β (Cloudflare Workers)

既存の FastAPI 版とは独立した、Cloudflare Workers + Static Assets 上の β 版。

| 項目 | 値 |
|------|-----|
| β URL | https://webscreen-beta.teranori.workers.dev |
| Worker 名 | `webscreen-beta` |
| パッケージマネージャ | bun（npm は使わない） |

## コマンド

```bash
bun install
bun run build       # dist/client（静的） + dist/server（Worker）を生成
bun run typecheck   # astro check はサンドボックスで EPERM になるため tsc を使う
bunx wrangler deploy -c dist/server/wrangler.json
```

デプロイ設定は 2 段構成。`wrangler.jsonc` がルート設定（name / compatibility_date /
assets / bindings）で、ビルド時に `@astrojs/cloudflare` がこれを取り込んで
`dist/server/wrangler.json` を生成する。**デプロイは必ず生成物を `-c` で指定する。**

## バインディング

| binding | 種別 | リソース |
|---------|------|----------|
| `DB` | D1 | `webscreen-beta-db` |
| `BUCKET` | R2 | `webscreen-beta` |
| `SESSION` | KV | Astro セッション用（初回 deploy で自動作成） |
| `ASSETS` / `IMAGES` | — | アダプタが自動付与 |

Astro 7 + adapter 14 では `locals.runtime.env` は廃止。env 参照は
`import { env } from 'cloudflare:workers'` を使う。

## trailingSlash: 'always'

`astro.config.mjs` で `trailingSlash: 'always'` を設定しているため、**API ルートも
末尾スラッシュが必須**（`/api/health/`）。スラッシュ無しでアクセスすると 301 で
末尾スラッシュ付きへリダイレクトされるので、fetch 側は最初から `/` を付けて叩く。

i18n は `prefixDefaultLocale: true` により全ロケールが `/{lang}/` 配下になる。
ルート `/` にはページが無く 404 になる（言語リダイレクトは未実装）。

## COOP/COEP の二重配送

FFmpeg.wasm の SharedArrayBuffer には `crossOriginIsolated` が必要で、
静的アセットと Worker 生成レスポンスでヘッダーの適用経路が異なる。

| 経路 | 適用元 | 検証 URL |
|------|--------|----------|
| 静的アセット | `public/_headers` | `/ja/`, `/_astro/*` |
| SSR / API ルート | `src/middleware.ts` | `/api/health/` |

`_headers` は Worker が生成したレスポンスには適用されないため、両方が必要。
片方だけ消すと SSR ページで `crossOriginIsolated === false` になる。

## ディレクトリ

```
src/pages/          ルーティング（/ja/ /en/ /api/）
src/lib/services/   ドメインロジック（未実装）
src/lib/infra/      D1 / R2 など外部依存の隔離（未実装）
src/components/     UI コンポーネント
```
