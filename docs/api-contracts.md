# API 契約（Cloudflare β）

**型・定数・バリデータの正本は TypeScript**。本ファイルはエンドポイントの一覧と公開範囲の契約だけを書き、
型の内容を再掲しない（二重管理を避けるため）。

| 契約 | 正本ファイル |
|------|-------------|
| リクエスト / レスポンス型、エラーコード、上限値、バリデータ | `web/src/lib/contracts/api.ts` |
| クライアント失敗報告（段・受け付けるコードの allowlist・本文上限） | `web/src/lib/contracts/client-error.ts` |
| セッション Cookie（名前・署名形式・TTL） | `web/src/lib/contracts/session.ts` |
| R2 オブジェクトキー、shortId 生成 | `web/src/lib/contracts/r2key.ts` |
| 配信セッションの状態・レスポンス型 | `web/src/lib/contracts/streams.ts`（`api.ts` から再 export） |
| DB スキーマ | `web/migrations/`（連番の全ファイル。適用は `wrangler d1 migrations apply`） |
| mp4 のエンコード条件 | [encode-contract.md](encode-contract.md) |

URL は `trailingSlash: 'always'`（末尾スラッシュ必須）。スラッシュなしは 404 になる。

## Worker API

| メソッド / パス | 用途 | 認証 | 型 |
|---|---|---|---|
| `GET /api/health/` | 疎通確認 + 保持期間バッチの鮮度（`cron`。読めない時は `{ error: true }`） | 不要 | `CronHealthSection`（`services/cron-health.ts`） |
| `GET /api/auth/login/` | Discord OAuth 開始（state Cookie を発行してリダイレクト） | 不要 | `session.ts` |
| `GET /api/auth/callback/` | OAuth コールバック（state 検証 → users upsert → セッション Cookie 発行） | 不要 | `session.ts` |
| `POST /api/auth/logout/` | セッション Cookie の破棄（form の `lang` のトップへ 303 リダイレクト。不正・欠落は `ja`） | 本人 | — |
| `GET /api/me/` | ログイン中のユーザー情報 | 本人 | 未ログインは 401。応答の `name` は表示用。**Chrome 拡張（web-screen-extension）が host_permissions 経由の Cookie 付き fetch でログイン判定と表示名に使う**ため、401 の意味と `name` の形を変える時は拡張側も追随が要る |
| `POST /api/uploads/presign/` | R2 へのアップロード先を払い出し、movies に `pending` 行を原子的に容量予約して作る | 本人 | `PresignRequest` / `PresignResponse`。予約後の合計が容量上限を超える場合は 413 `PAYLOAD_TOO_LARGE`、同時 pending が 10 件なら 429 `TOO_MANY_PENDING_UPLOADS` |
| `POST /api/uploads/commit/` | R2 の実測サイズで容量を原子的に再判定し、アップロード完了を `ready` にする | 本人（当該 movie の所有者） | `CommitRequest` / `CommitResponse`。実測サイズで容量上限を超える場合は 413 `PAYLOAD_TOO_LARGE` |
| `POST /api/uploads/abandon/` | 所有する `pending` アップロードを `failed` にし、署名 URL 失効後の保持期間バッチへ回収を委ねる | 本人（当該 movie の所有者） | `AbandonUploadRequest`。JSON 本文は 4 KiB 上限（超過は 413 `PAYLOAD_TOO_LARGE`）。対象が `pending` 以外・不存在・他人所有でも状態を漏らさず 204 |
| `GET /api/history/` | 自分の動画一覧 | 本人 | `HistoryResponse` |
| `POST /api/movies/{shortId}/pin/` | pin の切り替え（保管期限を 1 年後まで延ばす。期限切れは 410 `EXPIRED`） | 本人（所有者） | `PinResponse` |
| `PATCH /api/movies/{shortId}/` | ファイル名の変更 | 本人（所有者） | `RenameMovieRequest` / `RenameMovieResponse` |
| `DELETE /api/movies/{shortId}/` | `ready` 動画の削除（R2 の実体 → D1 の行の順） | 本人（所有者） | `pending` / `failed` は 409 `INVALID_REQUEST`。`pending` の破棄は abandon を使う |
| `POST /api/client-error/` | クライアント側の失敗報告（識別子だけを受けて `client_error` として構造化ログに残す。応答は 204） | 任意（Cookie があれば `userId` を添える） | `ClientErrorReport` |
| `POST /api/streams/` | 新しい 12 文字 path ID と publish JWT を発行 | 本人 | `CreateStreamResponse`。同時配信上限は 409 `STREAM_ALREADY_LIVE`、作成間隔内は 429 `STREAM_CREATE_RATE_LIMITED` |
| `POST /api/streams/{id}/extend/` | 延長期限を更新し、同じ期限の新 publish JWT を発行 | 本人（所有者） | `ExtendStreamResponse`。終了済みは 409 `STREAM_ENDED` |
| `POST /api/streams/{id}/heartbeat/` | 配信ブラウザの生存時刻を更新 | 本人（所有者） | 成功は 204。終了済みは 409 `STREAM_ENDED` |
| `POST /api/streams/{id}/stop/` | 配信を `user_stop` で終了し、cron の kick 対象にする | 本人（所有者） | 冪等 204 |
| `GET /api/streams/{id}/` | 配信状態を取得 | 本人（所有者） | `StreamStatusResponse`、`Cache-Control: no-store` |
| `GET /api/streams/jwks/` | MediaMTX が publish JWT を検証する公開 JWKS | 不要 | RS256 公開鍵のみ。秘密要素は返さない。`Cache-Control: no-store` |

エラーは全経路で `ErrorResponse`（`errorCode` + `message`）を返す。

### 配信JWTとMediaMTXの運用ゲート

#126 のMediaMTX構築前に、Workerの `STREAM_JWT_PRIVATE_KEY`、cron Workerの
`MEDIAMTX_API_URL` / `MEDIAMTX_API_TOKEN`、MediaMTXからのJWKS取得をすべて設定し、
JWKS取得とMediaMTX側の再読込を確認してから配信APIを利用可能にする。

現在のJWKSは単一鍵で、publish JWTは最大で延長サイクル（初期2時間）有効なため、鍵の即時切替は
active JWTとの互換を保てない。ローテーションは配信停止メンテナンスとして、secret投入 →
JWKS取得とMediaMTX再読込の確認 → API再開、の順で行う。無停止ローテーションにはprevious keyを
JWKSへ併載する後続対応が必要。

| 設定キー | 初期値 / 投入先 |
|---|---|
| `STREAM_EXTENSION_SECONDS` | `7200` / Web Worker vars |
| `STREAM_MAX_LIVE_PER_USER` | `1` / Web Worker vars |
| `STREAM_CREATE_INTERVAL_SECONDS` | `10` / Web Worker vars |
| `STREAM_NO_VIEWER_SECONDS` | `600` / cron Worker vars |
| `STREAM_HEARTBEAT_SECONDS` | `60` / cron Worker vars |

秘密値は `bunx wrangler secret put STREAM_JWT_PRIVATE_KEY`、
`bunx wrangler secret put MEDIAMTX_API_URL -c cron/wrangler.jsonc`、
`bunx wrangler secret put MEDIAMTX_API_TOKEN -c cron/wrangler.jsonc` で各 Worker へ投入する。

`/api/client-error/` は無認証なので、受け付けるのは allowlist に載る `stage` / `errorCode` /
`httpStatus` だけで、未知フィールド・1 KiB 超の本文・`application/json` 以外の Content-Type は
400 で捨てる。上限は 2 段構え:

- Worker 側: Rate Limiting binding `CLIENT_ERROR_LIMITER` で 30 回 / 分 / IP。超過は 429（本文なし）。
  binding が無い環境（古い `wrangler dev` 等）は警告を 1 回出して通す（テレメトリのために報告者を 500 にしない）
- クライアント側: 同じ段 + コードで最大 5 回、送信間隔 1 秒以上

それでも足りなければ zone の Rate Limiting Rule（WAF）で `/api/client-error/` をさらに絞る。

### 動画入力廃止に伴う互換性

2026-08-27 から `PresignRequest.kind` の入力元は PDF・画像・Web ページだけとし、旧画面や直接 API からの
`video` は `400 INVALID_REQUEST` で拒否する。互換期間は設けない。この変更は入力元の申告値だけを対象とし、
生成物の `video/mp4`、既存動画の履歴・再生・pin・rename・delete・retention 契約には影響しない。
元ファイルは Worker へ送られないため、`kind` は製品契約でありファイル内容を保証するセキュリティ境界ではない。

## web-capture API

Worker とは別サービス（ヘッドレスブラウザを持つ実行環境）。Worker からのみ呼ぶ。

| メソッド / パス | 認証 | 型 |
|---|---|---|
| `POST /capture` | `Authorization: Bearer {WEBCAPTURE_TOKEN}` | `CaptureRequest` / `CaptureResponse` |

- `CaptureResponse.images` は**撮影（スクロール）順**で返す。順序が狂うとスクロール動画が破綻する（詳細は `api.ts` の該当コメント）
- web-capture は動画化しない。画像を R2 に置いて URL を返すだけ（[encode-contract.md](encode-contract.md)）
- web-capture の lower code は、上流の HTTP ステータスと JSON の `errorCode` が
  allowlist の組み合わせに一致した場合だけ Worker の公開コードへ変換する。下流の `message` は返さない。

| web-capture lower code | Worker 公開 `errorCode` | HTTP |
|---|---|---|
| `pdf_url_not_supported` | `PDF_URL_NOT_SUPPORTED` | 422 |
| `image_url_not_supported` | `IMAGE_URL_NOT_SUPPORTED` | 422 |
| `video_url_not_supported` | `VIDEO_URL_NOT_SUPPORTED` | 422 |
| `non_web_page_url` | `NON_WEB_PAGE_URL` | 422 |
| `capture_limit_exceeded` | `PAGE_TOO_LONG` | 400 |
| `capture_timeout` | `CAPTURE_TIMEOUT` | 504 |

`capture_limit_exceeded` だけは、下流の応答に `estimatedImages`（ページ全体に必要と推定した画面数）が
付いていれば、検証済みの数値 1 つだけを `PAGE_TOO_LONG` の応答へ転送する（`message` は転送しない。
検証は `contracts/api.ts` の `parseEstimatedImages` が正本で、整数でない・範囲外の値は落とす）。
上限そのものは payload に載せない。両側が `MAX_CAPTURE_IMAGES` を持っているので、表示側が組み合わせる。

1 ページの上限枚数（`MAX_CAPTURE_IMAGES` = 150）は WebScreen と web-capture の共有契約。
web-capture は撮影を始める前にページ全体の高さを 1 回測り、`ceil(ページ高 / ビューポート高)` が
上限を超えていれば 1 枚も撮らずに `capture_limit_exceeded` を返す（値の根拠は
[encode-contract.md](encode-contract.md)「1 ページの上限枚数」）。

Worker 自身のタイムアウト（上流への 150 秒 abort）も `CAPTURE_TIMEOUT` / 504 で返す。
上の表の組み合わせに一致しないもの（未知コード、JSON でない応答、401 / 429 / その他の 5xx）は
すべて `CAPTURE_FAILED` として扱う。
これらの変換は Worker の構造化ログ（`lib/infra/worker-log.ts`）に 1 件だけ記録する。

## 公開範囲の契約

| 対象 | 公開範囲 | 補足 |
|------|---------|------|
| 動画 URL（`movies/{shortId}.mp4`） | **公開**（認証なしで誰でも取得可） | VRChat のプレイヤーが認証なしで取得する必要があるため。**将来も公開のまま変えない**。保護は 12 文字 base62 のランダム ID による推測困難性のみ |
| キャプチャ画像（`captures/{uuid}/{index}.{png\|jpg}`） | 公開 | 同上。動画生成の中間物。拡張子は web-capture の設定で決まる（撮影を速くするため JPEG へ移行中）。WebScreen 側は `CaptureResponse.images` の URL をそのまま取得して復号するため、どちらでも扱いは変わらない |
| 履歴 `GET /api/history/` | 本人のみ | セッション Cookie の uid で絞る |
| pin `POST /api/movies/{shortId}/pin/` | 本人のみ | 所有者チェック必須 |
| 削除 `DELETE /api/movies/{shortId}/` | 本人のみ | 所有者チェック必須。他人の shortId は 404（存在を漏らさない）。`ready` のみ削除でき、`pending` は署名 URL の遅延 PUT を追跡するため abandon で `failed` へ移す |
| プレビュー `GET /{shortId}/` | **公開**（認証なし） | 動画 URL と同じ扱い。`ready` 以外は 404。pin / 削除の操作 UI は所有者にだけ出す |
| commit `POST /api/uploads/commit/` | 本人のみ | 所有者チェック必須。他人の pending を確定できてはならない |
| abandon `POST /api/uploads/abandon/` | 本人のみ | 所有者条件付きで `pending` のみ `failed` にする。JSON 本文は 4 KiB 上限。`failed` / `ready` / 不存在 / 他人所有は状態を漏らさず 204。R2 は即時削除しない |

「動画は公開・操作は本人のみ」が原則。動画 URL を推測されないこと自体が保護なので、
shortId をログ・エラーメッセージ経由で無関係な第三者へ漏らさない。

動画 URL がどのドメインから配信されるか（Custom Domain と r2.dev の並走、削除時の
キャッシュの扱い）は [r2-delivery.md](r2-delivery.md) を参照。
