# トップ移行前の成功計測ベースライン（2026-09-03）

トップページの役割を変更する前に、画面共有と動画変換が「開始されたか」ではなく「利用可能な URL まで到達したか」を比較できるよう、GA4 の測定契約と取得手順を固定する。

## 状態

- コード側の計測契約: 実装済み
- DebugView / Realtime の受信確認: 未実施（GA4 プロパティへのログイン権限が必要）
- key event の設定: 未実施（GA4 管理画面での変更権限が必要）
- 移行前 7〜14 日の実測値: 未取得

未取得値は 0 とみなさない。トップ移行は、下記の外部確認と観測期間を満たしてから判断する。

## 成功イベントの定義

| イベント | 成功境界 | 二重送信防止 |
|---|---|---|
| `screen_share_start` | `getDisplayMedia` が画面を返した直後 | 画面選択の成功ごと |
| `screen_share_ready` | 同一配信で初めて health と現 publisher の映像送出を確認できた時 | 同一配信では再接続しても 1 回 |
| `screen_share_url_copy` | 共有 URL の clipboard 書き込み成功後 | コピー成功ごと |
| `convert_start` | URL またはファイルの事前検査を通過し、変換状態へ入った時 | 受理された変換ごと |
| `convert_complete` | MP4 の R2 PUT と `/api/uploads/commit/` が両方成功した後 | 変換ごとに 1 回 |

次のイベント名は後続 UI 用に型だけ予約し、対応する UI が存在するまで発火させない: `convert_url_copy`、`tool_nav_click`、`resume_prompt_impression`、`resume_prompt_click`。

## パラメータとプライバシー境界

送信を許可するのは次の列挙値だけ。

| パラメータ | 許可値 |
|---|---|
| `tool` | `screen_share`, `convert` |
| `source` | `home`, `screen_share_page`, `convert_page`, `header`, `resume` |
| `input_kind` | `web`, `image`, `pdf` |
| `locale` | `ja`, `en` |

入力 URL、ファイル名、shortId、配信 ID・token・URL、ユーザー ID・名前、エラー本文・stack、共有内容の情報は送らない。プレビューページは引き続き Analytics タグ自体を出力しない。本番ホスト `web-screen.net` の完全一致以外（localhost、E2E、`*.workers.dev`）では送信しない。

## 移行前に記録する値

DebugView で契約どおりの受信を確認し、`screen_share_ready` と `convert_complete` を key event に設定した翌日を観測開始日にする。連続 7〜14 日について、日別・locale 別に次を記録する。

| 指標 | 算出方法 | 実測値 |
|---|---|---|
| 画面共有開始数 | `screen_share_start` の event count | 未取得 |
| 画面共有成功数 | `screen_share_ready` の event count | 未取得 |
| 画面共有成功率 | ready / start | 未取得 |
| 変換開始数 | `convert_start` の event count | 未取得 |
| 変換成功数 | `convert_complete` の event count | 未取得 |
| 変換成功率 | complete / start | 未取得 |

URL とファイルの構成差を確認するため、変換指標は `input_kind` でも分ける。少数日の曜日偏りで判断しないため、最低 7 日を必須とする。

## GA4 管理画面での検証手順

1. 本番 `https://web-screen.net/ja/screen-share/` で画面選択、ready、URL コピーまで操作し、DebugView で 3 イベントと許可パラメータだけが届くことを確認する。
2. 本番のトップで URL 変換とファイル変換を各 1 回完了し、`convert_start` と `convert_complete` が各処理 1 回だけ届くことを確認する。
3. localhost、workers.dev、プレビュー URL ではイベントも Analytics タグも送られないことを確認する。
4. Admin の Events で `screen_share_ready` と `convert_complete` を key event に設定する。
5. Realtime で重複がないことを再確認し、翌日から上表の観測を開始する。

コード側の自動テストは、外部 GA4 への到達ではなく、ホストガード・許可された型・成功境界・計測障害時の製品継続を固定する。外部画面の確認結果と観測期間は、この文書へ日付と値を追記する。
