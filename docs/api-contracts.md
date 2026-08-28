# API 契約（Cloudflare β）

**型・定数・バリデータの正本は TypeScript**。本ファイルはエンドポイントの一覧と公開範囲の契約だけを書き、
型の内容を再掲しない（二重管理を避けるため）。

| 契約 | 正本ファイル |
|------|-------------|
| リクエスト / レスポンス型、エラーコード、上限値、バリデータ | `web/src/lib/contracts/api.ts` |
| セッション Cookie（名前・署名形式・TTL） | `web/src/lib/contracts/session.ts` |
| R2 オブジェクトキー、shortId 生成 | `web/src/lib/contracts/r2key.ts` |
| DB スキーマ | `web/migrations/0001_init.sql` |
| mp4 のエンコード条件 | [encode-contract.md](encode-contract.md) |

URL は `trailingSlash: 'always'`（末尾スラッシュ必須）。スラッシュなしは 404 になる。

## Worker API

| メソッド / パス | 用途 | 認証 | 型 |
|---|---|---|---|
| `GET /api/health/` | 疎通確認 | 不要 | — |
| `GET /api/auth/login/` | Discord OAuth 開始（state Cookie を発行してリダイレクト） | 不要 | `session.ts` |
| `GET /api/auth/callback/` | OAuth コールバック（state 検証 → users upsert → セッション Cookie 発行） | 不要 | `session.ts` |
| `POST /api/auth/logout/` | セッション Cookie の破棄（form の `lang` のトップへ 303 リダイレクト。不正・欠落は `ja`） | 本人 | — |
| `GET /api/me/` | ログイン中のユーザー情報 | 本人 | — |
| `POST /api/uploads/presign/` | R2 へのアップロード先を払い出し、movies に `pending` 行を作る | 本人 | `PresignRequest` / `PresignResponse` |
| `POST /api/uploads/commit/` | アップロード完了を確定し `ready` にする | 本人（当該 movie の所有者） | `CommitRequest` / `CommitResponse` |
| `GET /api/history/` | 自分の動画一覧 | 本人 | `HistoryResponse` |
| `POST /api/movies/{shortId}/pin/` | pin の切り替え（保管期限を 1 年後まで延ばす。期限切れは 410 `EXPIRED`） | 本人（所有者） | `PinResponse` |
| `PATCH /api/movies/{shortId}/` | ファイル名の変更 | 本人（所有者） | `RenameMovieRequest` / `RenameMovieResponse` |
| `DELETE /api/movies/{shortId}/` | 動画の削除（R2 の実体 → D1 の行の順） | 本人（所有者） | — |

エラーは全経路で `ErrorResponse`（`errorCode` + `message`）を返す。

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

Worker 自身のタイムアウト（上流への 150 秒 abort）も `CAPTURE_TIMEOUT` / 504 で返す。
上の表の組み合わせに一致しないもの（未知コード、JSON でない応答、401 / 429 / その他の 5xx）は
すべて `CAPTURE_FAILED` として扱う。
これらの変換は Worker の構造化ログ（`lib/infra/worker-log.ts`）に 1 件だけ記録する。

## 公開範囲の契約

| 対象 | 公開範囲 | 補足 |
|------|---------|------|
| 動画 URL（`movies/{shortId}.mp4`） | **公開**（認証なしで誰でも取得可） | VRChat のプレイヤーが認証なしで取得する必要があるため。**将来も公開のまま変えない**。保護は 12 文字 base62 のランダム ID による推測困難性のみ |
| キャプチャ画像（`captures/{uuid}/{index}.png`） | 公開 | 同上。動画生成の中間物 |
| 履歴 `GET /api/history/` | 本人のみ | セッション Cookie の uid で絞る |
| pin `POST /api/movies/{shortId}/pin/` | 本人のみ | 所有者チェック必須 |
| 削除 `DELETE /api/movies/{shortId}/` | 本人のみ | 所有者チェック必須。他人の shortId は 404（存在を漏らさない） |
| プレビュー `GET /{shortId}/` | **公開**（認証なし） | 動画 URL と同じ扱い。`ready` 以外は 404。pin / 削除の操作 UI は所有者にだけ出す |
| commit `POST /api/uploads/commit/` | 本人のみ | 所有者チェック必須。他人の pending を確定できてはならない |

「動画は公開・操作は本人のみ」が原則。動画 URL を推測されないこと自体が保護なので、
shortId をログ・エラーメッセージ経由で無関係な第三者へ漏らさない。

動画 URL がどのドメインから配信されるか（Custom Domain と r2.dev の並走、削除時の
キャッシュの扱い）は [r2-delivery.md](r2-delivery.md) を参照。
