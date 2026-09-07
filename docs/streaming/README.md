# ライブストリーミング（移管済み）

画面共有・ライブ配信（WHIP → MediaMTX → `rtspt://` → VRChat）は **2026-09-07 に姉妹サービス「ちょいキャス」へ移管した**。

- 移管先: [noricha-vr/choicast](https://github.com/noricha-vr/choicast) の `docs/streaming/`（設計・検証・運用・runbook はすべてそちらが正本）
- 本番: https://app.choicast.com/{lang}/
- このリポに残るのは旧 URL の 301 だけ（`web/public/_redirects` と `web/src/pages/screen-share.astro`）

以前ここにあった設計・検証記録・PoC・配信サーバー設定（`web/streaming/`）と配信コードは、本ディレクトリを 1 ファイルにした commit の git 履歴から辿れる。
D1 の `stream_sessions` / `stream_start_cancellations` / `node_egress_*` テーブルは意図して残している（`wrangler rollback` で D1 は戻らないため、DROP は別途判断する）。
