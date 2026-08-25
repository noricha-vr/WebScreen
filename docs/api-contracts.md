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
| `GET /api/auth/discord/` | Discord OAuth 開始（state Cookie を発行してリダイレクト） | 不要 | `session.ts` |
| `GET /api/auth/discord/callback/` | OAuth コールバック（state 検証 → users upsert → セッション Cookie 発行） | 不要 | `session.ts` |
| `POST /api/auth/logout/` | セッション Cookie の破棄 | 本人 | — |
| `GET /api/me/` | ログイン中のユーザー情報 | 本人 | — |
| `POST /api/presign/` | R2 へのアップロード先を払い出し、movies に `pending` 行を作る | 本人 | `PresignRequest` / `PresignResponse` |
| `POST /api/commit/` | アップロード完了を確定し `ready` にする | 本人（当該 movie の所有者） | `CommitRequest` / `CommitResponse` |
| `GET /api/history/` | 自分の動画一覧 | 本人 | — |
| `POST /api/movies/{shortId}/pin/` | pin の切り替え（自動削除の対象外にする） | 本人（所有者） | — |

エラーは全経路で `ErrorResponse`（`errorCode` + `message`）を返す。

## web-capture API

Worker とは別サービス（ヘッドレスブラウザを持つ実行環境）。Worker からのみ呼ぶ。

| メソッド / パス | 認証 | 型 |
|---|---|---|
| `POST /capture` | `Authorization: Bearer {WEBCAPTURE_TOKEN}` | `CaptureRequest` / `CaptureResponse` |

- `CaptureResponse.images` は**撮影（スクロール）順**で返す。順序が狂うとスクロール動画が破綻する（詳細は `api.ts` の該当コメント）
- web-capture は動画化しない。画像を R2 に置いて URL を返すだけ（[encode-contract.md](encode-contract.md)）

## 公開範囲の契約

| 対象 | 公開範囲 | 補足 |
|------|---------|------|
| 動画 URL（`movies/{shortId}.mp4`） | **公開**（認証なしで誰でも取得可） | VRChat のプレイヤーが認証なしで取得する必要があるため。**将来も公開のまま変えない**。保護は 12 文字 base62 のランダム ID による推測困難性のみ |
| キャプチャ画像（`captures/{uuid}/{index}.png`） | 公開 | 同上。動画生成の中間物 |
| 履歴 `GET /api/history/` | 本人のみ | セッション Cookie の uid で絞る |
| pin `POST /api/movies/{shortId}/pin/` | 本人のみ | 所有者チェック必須 |
| commit `POST /api/commit/` | 本人のみ | 所有者チェック必須。他人の pending を確定できてはならない |

「動画は公開・操作は本人のみ」が原則。動画 URL を推測されないこと自体が保護なので、
shortId をログ・エラーメッセージ経由で無関係な第三者へ漏らさない。
