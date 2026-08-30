# 動画配信（R2）の構成

動画の実体は R2 バケット `webscreen-beta` にあり、**2 つの経路で公開されている**。コード側の入力は `web/wrangler.jsonc` の `vars.R2_PUBLIC_BASE_URL` 1 箇所だけで、URL は保存値ではなく毎回そこから組み立てる（`web/src/lib/services/movies.ts` の `publicUrl()`）。

| 経路 | URL | 用途 | 無効化してよいか |
|---|---|---|---|
| Custom Domain | `https://cdn.web-screen.net` | **現行**。新規に払い出す URL はすべてこちら | 不可（現行の配信が止まる） |
| Public Development URL | `https://pub-ebb48e6efc2f4128b606cf381851cae5.r2.dev` | 切替前に払い出した共有リンクの互換維持 | **不可**（VRChat のワールドや利用者の手元に貼られた URL が壊れる） |

Cloudflare 上で 2 つは独立して有効・無効を切り替えられる。**互換期間中は r2.dev を無効化しない。** 停止する判断をする時は、既存リンクが壊れることを承知のうえで別途 Issue を立てること。

## なぜ Custom Domain へ移したか

r2.dev は Cloudflare が開発専用と明記しているエンドポイント（[Public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)・参照日 2026-08-27）。

> Public access through `r2.dev` subdomains is rate-limited and should only be used for development purposes.
> This endpoint is intended for non-production traffic.

WebScreen では VRChat のワールド内で複数人が同時に同じ動画を取得するため、レート制限がそのまま「再生できない」というユーザー影響になる。キャッシュが効かない点も配信コストと再生開始の遅さに直結する。

## Cloudflare 側の設定

| 設定 | 管理場所 | 内容 |
|---|---|---|
| R2 Custom Domain | ダッシュボード | バケット `webscreen-beta` に `cdn.web-screen.net` を接続（Active） |
| Transform Rule `cdn: noindex for media` | ダッシュボード | `http.host eq "cdn.web-screen.net"` のとき `X-Robots-Tag: noindex` を付与 |
| **R2 の CORS** | **`web/r2-cors.json`** | 下記「CORS」節 |

ダッシュボード管理のものは変更したらこの表も更新すること。

### CORS（アップロード経路）

アップロードはブラウザから **R2 の S3 エンドポイントへ直接 PUT** する（`web/src/lib/infra/r2presign.ts` が署名 URL を払い出す）。配信ドメインではなく `https://{accountId}.r2.cloudflarestorage.com` が相手なので、**サイトのオリジンを R2 のバケット CORS に登録しないと preflight が 403 になり変換できない**。

設定の正本は `web/r2-cors.json`。反映はこのコマンド:

```bash
cd web && bunx wrangler r2 bucket cors set webscreen-beta --file r2-cors.json
bunx wrangler r2 bucket cors list webscreen-beta   # 確認
```

**サイトのオリジンが増減したら必ずここも直す。** 2026-08-27 の本番ドメイン切替では、`https://web-screen.net` の登録漏れで変換が全滅した（`presign` は 200 を返すのに R2 への PUT だけが CORS エラーになるため、原因が分かりにくい）。

`AllowedMethods` に `PUT` が要るのはアップロードのため、`GET` / `HEAD` は動画再生のため。`ExposeHeaders` の `ETag` はアップロード完了の検証に使う。

`X-Robots-Tag` は、プレビューページの `noindex` メタタグだけでは防げない「動画ファイル本体がクローラに直接収集される」経路を塞ぐためのもの（HTML の noindex はその HTML を検索結果から外すだけで、`<video src>` の先には効かない）。

## captures/ の掃除主体

`captures/{uuid}/{index}.{png|jpg}`（web-capture が置く動画化の中間物。拡張子は web-capture の設定で決まる。撮影を速くするため JPEG へ移行中で、掃除も取り込みも拡張子を見ないので混在しても問題ない）を消すのは **WebScreen の cron だけ**（`web/cron/` の Worker が `web/src/lib/services/retention-captures.ts` を毎時 17 分に実行し、アップロードから 24 時間経過したものを 1 回あたり最大 1000 件・list 10 ページまで削除する。残りは次の実行が拾う）。**R2 の lifecycle rule は使っていない**（作成もしていない）。掃除を別の場所へ移す時は、この節と `retention-captures.ts` の両方を同時に直すこと。

掃除対象バケット名の正本は **`web/cron/wrangler.jsonc` の `r2_buckets`**（現在 `webscreen-beta`）。web-capture 側の書き込み先（Cloud Run の環境変数 `R2_BUCKET`）が**これと一致していることが契約**で、ずれると中間のキャプチャ画像は誰にも消されず増え続ける（気づけるのは請求だけ）。2026-08-30 に `gcloud run services describe web-capture` で一致を確認済み。どちらかを変える時は両方同時に変える。

## 削除とキャッシュの既知の穴

**動画を削除しても、最大 120 分はキャッシュから配信され続ける。**

- mp4 は Cloudflare の[既定キャッシュ対象](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)に含まれ、200 / 206 の Edge TTL は 120 分（参照日 2026-08-27）
- 削除経路（`services/movies.ts` の `deleteMovie` と `services/retention.ts` の期限切れ削除）はどちらも R2 の `delete` を呼ぶだけで、**キャッシュの purge をしていない**
- r2.dev 経由ではキャッシュされないため、この挙動は Custom Domain 化で新たに生じたもの

URL を知っている人にしか影響しない（そもそも公開 URL である旨はプライバシーポリシーに明記）が、「削除したのに見られる」はユーザーの期待を裏切る。対処は Issue で追跡している。
