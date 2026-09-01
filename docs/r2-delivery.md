# 動画配信（R2）の構成

動画の実体は R2 バケット `webscreen` にあり、**2 つの経路で公開されている**。URL は保存値ではなく毎回 `vars.R2_PUBLIC_BASE_URL` から組み立てる（`web/src/lib/contracts/r2key.ts` の `movieUrl()`）。入力は `web/wrangler.jsonc` の同 var で、保持期間バッチが同じ URL を purge するため `web/cron/wrangler.jsonc` にも同じ値を置いている（下の「削除とキャッシュ」節）。

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
| R2 Custom Domain | ダッシュボード | バケット `webscreen` に `cdn.web-screen.net` を接続（Active） |
| Transform Rule `cdn: noindex for media` | ダッシュボード | `http.host eq "cdn.web-screen.net"` のとき `X-Robots-Tag: noindex` を付与 |
| **R2 の CORS** | **`web/r2-cors.json`** | 下記「CORS」節 |

ダッシュボード管理のものは変更したらこの表も更新すること。

### CORS（アップロード経路）

アップロードはブラウザから **R2 の S3 エンドポイントへ直接 PUT** する（`web/src/lib/infra/r2presign.ts` が `tmp/{shortId}` への署名 URL を払い出す）。配信ドメインではなく `https://{accountId}.r2.cloudflarestorage.com` が相手なので、**サイトのオリジンを R2 のバケット CORS に登録しないと preflight が 403 になり変換できない**。

署名先と配信先は分離する。ブラウザが書けるのは公開 URL に採用しない `tmp/{shortId}` だけで、commit は同じ R2 binding から一時実体を `get()` し、実測サイズを検証してから body stream を `movies/{shortId}.mp4` へ条件付き `put()`（`etagDoesNotMatch: '*'`）する。並行 commit で条件が成立しなければ既存公開 object の実測サイズを D1 確定値に使い、最初の公開コピーを上書きしない。ready 化後は `tmp/` を削除する。50 MiB の実体を Worker メモリへバッファ化しない。

この分離により、5 分間の署名 URL が再利用されても書き換わるのは `tmp/` だけで、commit 済みの `movies/` は上書きされない。ready DELETE 後に同じ署名 URL を再利用しても公開キーは復活しない。なお同一バケットの Custom Domain は prefix 単位の読取 ACL ではないため、「公開 URL に採用しない」は `tmp/` の読取拒否を意味しない。読取自体も遮断する場合は、別の private bucket または配信 Worker で `tmp/` を拒否する設計が別途必要になる。

設定の正本は `web/r2-cors.json`。反映はこのコマンド:

```bash
cd web && bunx wrangler r2 bucket cors set webscreen --file r2-cors.json
bunx wrangler r2 bucket cors list webscreen   # 確認
```

**サイトのオリジンが増減したら必ずここも直す。** 2026-08-27 の本番ドメイン切替では、`https://web-screen.net` の登録漏れで変換が全滅した（`presign` は 200 を返すのに R2 への PUT だけが CORS エラーになるため、原因が分かりにくい）。

`AllowedMethods` に `PUT` が要るのはアップロードのため、`GET` / `HEAD` は動画再生のため。`ExposeHeaders` の `ETag` はアップロード完了の検証に使う。

`X-Robots-Tag` は、プレビューページの `noindex` メタタグだけでは防げない「動画ファイル本体がクローラに直接収集される」経路を塞ぐためのもの（HTML の noindex はその HTML を検索結果から外すだけで、`<video src>` の先には効かない）。

### 未確定 PUT の回収

PUT の署名 URL は 5 分有効。ブラウザから `Content-Length` を固定できず、R2 が署名した長さを
実体サイズの上限として検証する保証もないため、申告サイズだけで PUT 自体を制限しない。
署名失効 + 60 秒後も `pending` の行は `failed` へ移し、保持期間バッチが `tmp/{shortId}` と、旧実装が直接署名していた `movies/{shortId}.mp4` の両方を毎時反復削除する。
`failed` 行は 24 時間残すので、失効直前に開始した PUT が最初の削除後に完了しても次回に回収できる。
バッチは既存の 24 時間超 `failed` 行を削除してから `pending` を `failed` へ移し、その実体を
同じ実行の failed object sweep で R2 から削除する。24 時間超の backlog も D1 行はその場で消さず、
最低 1 サイクル追跡してから次回以降の failed 行削除へ渡す。

### presign のレート制限

`POST /api/uploads/presign/` は Workers Rate Limiting binding `PRESIGN_LIMITER` で、認証済みユーザーごとに 10 回 / 60 秒へ制限する。`web/wrangler.jsonc` の namespace `1002` が正本で、pending 10 件上限とは別に、短時間の署名発行と一時オブジェクト作成によるコストを抑える。

この binding のカウンタは Cloudflare のロケーション（PoP）単位で、更新は eventual consistency のため厳密な全世界共通上限ではない。アプリ側の pending 件数・容量検査は引き続き必須であり、この制限だけをクォータ境界には使わない。

### tmp/ の Lifecycle 安全網

アプリの commit・abandon・保持期間バッチが `tmp/` の主掃除主体で、R2 Lifecycle は D1 行が消えた後の遅延 PUT や継続的な R2 障害に対する最終安全網にする。Cloudflare ダッシュボードで次のルールを設定する。

1. R2 Object Storage から対象バケット `webscreen` を開く。
2. Settings → Object lifecycle rules → Add rule を選ぶ。
3. prefix を `tmp/`、action を object expiration、期間を 1 day にする。
4. 保存後、ルールが Enabled で prefix が `tmp/` に限定されていることを確認する。

推奨 TTL は 1 日。署名 TTL 5 分と時計差の猶予 60 秒を十分に越え、進行中 PUT を早期削除せず、それでも追跡不能な一時実体の課金期間を 24 時間程度に抑えられる。`movies/` や `captures/` を同じルールへ含めると公開動画・変換中画像を失うため、prefix なしのルールは禁止する。

## captures/ の掃除主体

`captures/{uuid}/{index}.{png|jpg}`（web-capture が置く動画化の中間物。拡張子は web-capture の設定で決まる。撮影を速くするため JPEG へ移行中で、掃除も取り込みも拡張子を見ないので混在しても問題ない）を消すのは **WebScreen の cron だけ**（`web/cron/` の Worker が `web/src/lib/services/retention-captures.ts` を毎時 17 分に実行し、アップロードから 24 時間経過したものを 1 回あたり最大 1000 件・list 10 ページまで削除する。残りは次の実行が拾う）。`tmp/` 専用ルールと違い、**`captures/` に R2 Lifecycle rule は使わない**。掃除を別の場所へ移す時は、この節と `retention-captures.ts` の両方を同時に直すこと。

掃除対象バケット名の正本は **`web/cron/wrangler.jsonc` の `r2_buckets`**（現在 `webscreen`。2026-09-01 に webscreen-beta から改名）。web-capture 側の書き込み先（Cloud Run の環境変数 `R2_BUCKET`）が**これと一致していることが契約**で、ずれると中間のキャプチャ画像は誰にも消されず増え続ける（気づけるのは請求だけ）。2026-08-30 に `gcloud run services describe web-capture` で一致を確認済み。どちらかを変える時は両方同時に変える。

## 削除とキャッシュ

mp4 は Cloudflare の[既定キャッシュ対象](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/)で、200 / 206 の Edge TTL は 120 分（参照日 2026-08-27）。R2 から実体を消しただけでは、その間キャッシュから配信され続ける（r2.dev 経由ではキャッシュされないため、Custom Domain 化で生じた挙動）。

そのため**動画の削除経路は、R2 の実体を消した直後に公開 URL の purge を投げる**。

| 経路 | 実装 |
|---|---|
| 所有者の削除（`DELETE /api/movies/{shortId}/`、`ready` のみ） | `web/src/lib/services/movies.ts` の `deleteMovie` |
| 保持期間バッチ（期限切れ・署名失効後の pending・failed の掃除） | `web/src/lib/services/retention.ts`、`retention-pending.ts`、`retention-failed.ts` |

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
