# 動画配信（R2）の構成

動画の実体は R2 バケット `webscreen-beta` にあり、**2 つの経路で公開されている**。URL は保存値ではなく毎回 `vars.R2_PUBLIC_BASE_URL` から組み立てる（`web/src/lib/contracts/r2key.ts` の `movieUrl()`）。入力は `web/wrangler.jsonc` の同 var で、保持期間バッチが同じ URL を purge するため `web/cron/wrangler.jsonc` にも同じ値を置いている（下の「削除とキャッシュ」節）。

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

## 削除とキャッシュ

mp4 は Cloudflare の[既定キャッシュ対象](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)で、200 / 206 の Edge TTL は 120 分（参照日 2026-08-27）。R2 から実体を消しただけでは、その間キャッシュから配信され続ける（r2.dev 経由ではキャッシュされないため、Custom Domain 化で生じた挙動）。

そのため**動画の削除経路は、R2 の実体を消した直後に公開 URL の purge を投げる**。

| 経路 | 実装 |
|---|---|
| 所有者の削除（`DELETE /api/movies/{shortId}/`） | `web/src/lib/services/movies.ts` の `deleteMovie` |
| 保持期間バッチ（期限切れ・pending 孤児・failed の掃除） | `web/src/lib/services/retention.ts` の各経路 |

`captures/` の掃除（`retention-captures.ts`）は purge しない。中間 PNG は変換が終われば誰も参照せず、キャッシュに残っても動画の削除の意図に反しないため。

purge の実体は `web/src/lib/infra/cloudflare-purge.ts`（Cloudflare の `purge_cache` API）、URL の組み立てと 30 件ずつの分割は `web/src/lib/services/cache-purge.ts`。**公開 URL は `contracts/r2key.ts` の `movieUrl()` で組み立てる**（purge は URL の完全一致でしか効かないため、表示側と別々に組み立てない）。

設定は 2 つ。**どちらかが欠けると purge せず `cache_purge_skipped` を warn するだけで、削除自体は成功する**（ローカル開発はこの状態が正常）。

| 名前 | 置き場所 | 備考 |
|---|---|---|
| `CLOUDFLARE_ZONE_ID` | `web/wrangler.jsonc` と `web/cron/wrangler.jsonc` の `vars` | 公開情報。両方に同じ値を置く |
| `CLOUDFLARE_PURGE_TOKEN` | secret（本体 Worker と cron Worker の両方） | `bunx wrangler secret put CLOUDFLARE_PURGE_TOKEN`（cron は `-c cron/wrangler.jsonc`） |

`R2_PUBLIC_BASE_URL` も cron 側の `vars` に同じ値で置いている（バッチが同じ公開 URL を組み立てるため）。**片方だけ変えると purge が空振りする。**

残る穴と観測方法:

- **purge に失敗した分は最大 120 分残る**。削除自体は完了しているのでリトライせず、自然に切れるのを待つ（`cache_purge_failed` を warn で記録。cron は `cachePurgeRequests` / `cachePurgeFailures` を毎回のログに出し、失敗があれば severity が warn になる）
- R2 の削除に失敗した動画は purge しない（実体が残っており、purge しても次の取得でキャッシュに戻るため）。次回のバッチが同じ順序でやり直す
