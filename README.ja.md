# WebScreen

**[English](README.md)**

Web ページ・画像・PDF を、VRChat のビデオプレイヤーで再生できる MP4 に変換します。

https://web-screen.net

VRChat のビデオプレイヤーは Web ページやスライド、スクリーンショットをそのまま開けません。動画しか再生できないためです。
WebScreen はそれらを「上から下へスクロールする動画」に変換し、プレイヤーに貼るための URL を返します。

## 使い方

1. https://web-screen.net を開き、Discord でログインする
2. 変換したいものを渡す:
   - **URL** — ページを上から下まで撮影し、スクロールする動画にする
   - **PDF** — 1 ページ 1 フレーム
   - **画像**（png / jpg / jpeg / webp / gif） — 1 枚 1 フレーム
3. 表示された動画 URL をコピーする
4. VRChat のビデオプレイヤーに貼り付ける

全フレームをキーフレームとしてエンコードしているため、VRChat のプレイヤーでどの位置へでもすぐシークできます。

## 制限

| | |
|---|---|
| 1 ファイルのサイズ | 50 MB |
| 1 ユーザーの合計 | 500 MB |
| 保管期間 | 30 日 |
| ピン留め | 10 件まで 1 年間 |

動画は公開 URL で配信されます。URL を知っている人は誰でも再生できます。保護は 12 文字のランダムな ID だけなので、
公開されて困るものは変換しないでください。

## プライバシー

ログインは Discord の OAuth を使います。変換した動画は Cloudflare R2 に保存し、保管期間を過ぎると自動で削除されます。
詳細はサイト内のプライバシーページを参照してください。

## 開発

Cloudflare Workers（Astro + D1 + R2）で動いています。Web ページを撮影するサービスは別リポジトリにあります:
[web-capture](https://github.com/noricha-vr/web-capture)。

```bash
cd web
bun install
cp .dev.vars.example .dev.vars   # 値を埋める
bun run dev                      # http://localhost:4321
bun test
bunx playwright test
```

`main` への push で GitHub Actions が本番へデプロイします。

ディレクトリ構成・規約・壊してはいけないものは [CLAUDE.md](CLAUDE.md) にまとめてあります。

> [!NOTE]
> リポジトリ直下のファイル（`router/`、`movie_maker/`、`templates/`、`Dockerfile` など）は以前の FastAPI 実装です。
> 新規開発はしておらず、いずれ削除します。

## ライセンス

[LICENSE.md](LICENSE.md) を参照してください。
