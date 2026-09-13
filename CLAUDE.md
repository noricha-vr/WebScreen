# CLAUDE.md

Claude Code / Codex がこのリポジトリで作業するときの共通の地図（`AGENTS.md` はこのファイルへの相対シンボリックリンク）。詳細は各リンク先を正本とし、ここには判断に効く情報だけ置く。

## このリポジトリは 2 系統が同居している

| 系統 | 実体 | 状態 |
|------|------|------|
| **現行**（ここを触る） | `web/` — Astro + Cloudflare Workers + D1 + R2 | 本番 https://web-screen.net |
| 旧（触らない） | リポジトリ直下の `router/` `movie_maker/` `templates/` `static/` `api/` 等 — FastAPI + Selenium + GCS | **廃止予定**。Cloud Run で古いリビジョンが稼働したままだが新規開発しない |

<critical_rule>
**新しい機能・修正は `web/` に入れる。** 旧系統のファイルは、明示的に「旧版を直して」と指示された時以外は編集しない。
`Dockerfile` / `docker-compose.yaml` / `cloudbuild.yaml` / `requirements.txt` も旧系統専用（Cloud Build のトリガーは無効化済み）。
</critical_rule>

関連サービスは別リポにある: [web-capture](https://github.com/noricha-vr/web-capture)（Cloud Run。URL のスクリーンショットを撮って R2 へ置く）。

## 何をするプロダクトか

Web ページ・画像・PDF を、VRChat のビデオプレイヤーで再生できる MP4 に変換して配る。
変換した動画は公開 URL を持ち、VRChat に貼るだけで再生できる。

## web/ の構成

| パス | 役割 |
|------|------|
| `web/src/pages/` | エントリポイント（`api/` は Worker の API、`[shortId]/` はプレビューとダウンロード） |
| `web/src/lib/contracts/` | **API の契約の正本**。`api.ts` が producer（Worker）と consumer（ブラウザ・web-capture）の共通定義 |
| `web/src/lib/services/` | ドメインロジック（D1 / R2 の操作、認証、保持期間） |
| `web/src/lib/convert/` | ブラウザ内変換（PDF.js / FFmpeg.wasm） |
| `web/src/lib/ui/` | 画面の配線（DOM 操作と状態遷移） |
| `web/src/i18n/` | **表示文言の正本**（ja / en）。テンプレートや JS に文言を直書きしない |
| `web/cron/` | 保持期間バッチ（別 Worker。同じ D1 / R2 を共有する） |
| `web/migrations/` | D1 のマイグレーション |

## 開発

```bash
make install         # 初回のみ（web/ の依存を lockfile 固定で入れる）
make help
make check
make e2e
make test-tools      # Python の検証ツール（実機接続なし）
```

`web/.dev.vars` にローカル用の環境変数が要る（`.dev.vars.example` を参照）。

- ローカル環境・E2E の落とし穴（dev サーバー復旧・ポート分離・Claude Code サンドボックス）は [docs/local-dev.md](docs/local-dev.md)

### 変更に応じた検証

- 通常の変更: `make check`。画面・変換フローの変更は `make e2e` も実行する。
- 運用ツールの変更: `make test-tools`。コマンド一覧は `make help`。
- エンコード・動画配信経路の変更: 実際の生成物を `make video-check FILE=...` で検査し、Windows の VRChat で実再生を確認する。自動テストだけで実再生成功と扱わない。実機へ接続できなければ未検証と記録する。
- Windows 接続先は `VRCHAT_SSH_HOST`（必須、既定値なし）。設定と画面操作は [Windows 実機検証手順](docs/windows-vrchat-verification.md) を参照する。

## デプロイ

main への push で GitHub Actions が本番へ反映する（`.github/workflows/deploy.yml`）。
型チェック → ユニットテスト → ビルド → D1 マイグレーション → Worker 2 つ → 疎通確認、の順で、失敗したら自動でロールバックする。

<critical_rule>
**`wrangler rollback` は Worker のコードしか戻さない。** D1 / R2 のデータも cron スケジュールも戻らない。
そのため D1 の変更は必ず後方互換にする（破壊的変更は「追加 → 切替 → 削除」の 3 段階に分ける）。
</critical_rule>

判断材料の詳細は playbook ノート `playbook-cloudflare-workers-deploy` にある（`note use` で読む）。

## 変更するときに見る正本

| 対象 | 正本 |
|------|------|
| API の型・エラーコード・バリデーション | `web/src/lib/contracts/api.ts` |
| R2 のキー規則 | `web/src/lib/contracts/r2key.ts` |
| 上流（web-capture）との契約 | [docs/api-contracts.md](docs/api-contracts.md) |
| 動画のエンコード条件（VRChat 互換） | [docs/encode-contract.md](docs/encode-contract.md) |
| Windows の VRChat 操作・再生検証 | [docs/windows-vrchat-verification.md](docs/windows-vrchat-verification.md) |
| R2 の配信とキャッシュ | [docs/r2-delivery.md](docs/r2-delivery.md) |
| ライブ配信（画面共有） | **2026-09-07 に ちょいキャス（[noricha-vr/choicast](https://github.com/noricha-vr/choicast)）へ移管**。このリポには 301 だけ残す（`web/public/_redirects` / `web/src/pages/screen-share.astro`）。経緯は [docs/streaming/README.md](docs/streaming/README.md) |
| 表示文言 | `web/src/i18n/ja.json` / `en.json` |
| 実装コンベンション（D1 条件付き更新・R2 etag・Workers 間通信・SSG の時刻） | [docs/coding-conventions.md](docs/coding-conventions.md) |
| ローカル開発・E2E（ポート分離・サンドボックス） | [docs/local-dev.md](docs/local-dev.md) |

## 気をつけること

- **文言をコードに直書きしない**（辞書経由。テンプレートへは `data-*` 属性で渡す）
- **エラーを握り潰さない**。上流のエラーコードは表示文言まで届ける。Worker の失敗は `lib/observability/worker-log.ts` で構造化ログに残す
- **VRChat 互換のエンコード条件を変えない**（全キーフレーム `-g 1 -bf 0`。変えると再生できなくなる）
- 変換した動画とキャプチャ画像は**公開**（認証なしで取得できる）。保護は 12 文字のランダム ID だけ
- ブラウザ内変換は FFmpeg.wasm を使うため COOP/COEP ヘッダーが要る（`web/src/middleware.ts`）
- **D1 の条件付き更新（期限・容量・上限）は事前 SELECT で判定せず WHERE で守る**（詳細: [docs/coding-conventions.md](docs/coding-conventions.md)）
- **利用ログ（D1 `usage_events`）は消さない**。movies の行は保持期間で消えるので、「誰が・いつ・何を・どれだけ」は `services/usage-log.ts` 経由でこのテーブルに残す（commit・削除・pin・期限切れ・ログイン）。集計は `make usage-report`。GA4 のイベント契約は `web/src/lib/ui/analytics.ts`（公開 ID・URL・例外本文は送らない）

## Review guidelines

- すべてのレビューコメントは日本語で記述してください。
- コードの問題点、改善提案、賞賛はすべて日本語で行ってください。
