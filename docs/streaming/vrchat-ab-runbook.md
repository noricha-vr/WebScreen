# VRChat 実機 A/B 検証の手順（コピペ用）

画面共有の設定候補を VRChat 実機で比べる時の固定手順。計測装置の詳細は [latency-harness.md](latency-harness.md)、結果の記録先は [verification.md](verification.md)。

## 固定値

| 項目 | 値 |
|---|---|
| 配信元（計測ページ） | `http://127.0.0.1:0/latency-source.html?tones=1`（ms 時刻のブロックコード + 毎秒ビープ。`?load=heavy` は帯域飢餓の最悪素材） |
| 配信 URL の通知先 | Discord「通知」チャンネル `1380914078100488334`（skill `discord-mention` の既定） |
| 通知コマンド | 環境変数 `WEBSCREEN_LATENCY_NOTIFY_COMMAND` で注入する（未 export だと `--notify-discord` を付けても警告のみで通知されない）。値の形と例: [latency-harness.md](latency-harness.md#配信-url-の通知コマンド) |
| VRChat 側 | Windows `win2022`（SSH で gdigrab 録画）。プレイヤーのあるワールド（YamaStream）でプレイヤーを正面に映す |
| 配信サーバー | `webscreen-indigo-poc`（`--server-snap` で ingress / egress を撮る） |
| 出力 | `docs/tmp/latency/<UTC>/`（git 管理外）。`summary.md` の「VRChat プレイヤー」節と「プロファイル区間別」節を見る |

## 人がやること（毎回同じ）

1. Windows で VRChat を起動し、プレイヤーのあるワールドに入る（前の配信が終わって Player Error が出ていたら、ワールドに入り直す）
2. Discord「通知」に届いた `rtspt://webscreen.tv/live/…` を **1 回だけ**貼る
3. run が終わるまで（`--minutes` 分）プレイヤーを正面に近い視点で映し続ける。斜めになると復号できない

## コマンド

事前確認（初回・環境が変わった時）:

```bash
cd web
bun scripts/latency-probe.ts login              # 初回のみ。開いた Chrome でログイン
bun scripts/latency-probe.ts player-check --seconds 8   # Windows 録画の疎通。録画長が 8 秒なら OK
```

A/B を 1 本の配信で往復（推奨。URL は 1 回貼るだけ）:

```bash
cd web
bun scripts/latency-probe.ts run --minutes 12 --ab-cycle 120 \
  --source 'http://127.0.0.1:0/latency-source.html?tones=1' \
  --video-profile quality --max-bitrate 1500000 \
  --player win2022 --notify-discord 1380914078100488334 --server-snap webscreen-indigo-poc
```

初回 run で発行された ID を控える。
以後は `--stream-id AbCdEf123456` を付けて run すると、同じ配信 URL を再利用できる。
指定できるのは、終了済みでログイン中ユーザーが所有する ID だけ。前の配信の期限が切れ、停止処理が完了するまでは同じ ID を再利用できない。

- `--ab-cycle 120` で quality → realtime → … を 2 分ごとに切り替える（6 区間）。`--max-bitrate` は realtime 区間の上限
- 単一プロファイルで測る時は `--ab-cycle` を外し、`--video-profile quality` または `--video-profile realtime --max-bitrate 1500000`

## ノード比較（Indigo origin と Cherry origin）

Cherry（`chi1.web-screen.net` / `ssh webscreen-cherry`）を origin にした経路を測る時は、通常 run と `--node-host` run を同じ素材で交互に取る（[latency-harness.md](latency-harness.md)「別ノードを origin にして測る」）。

| run | コマンドの差分 | VRChat に貼る URL | 分かること |
|---|---|---|---|
| A（基準） | 通常（`--server-snap webscreen-indigo-poc`） | `rtspt://webscreen.tv/live/{id}` | 現行 Indigo の値 |
| B | `--node-host chi1.web-screen.net --server-snap webscreen-cherry` | Discord に届く `rtspt://chi1.web-screen.net/live/{id}` | ブラウザ → Chicago → VRChat の本命経路 |
| C | 通常 run のまま、URL だけ Cherry を指定 | `rtspt://88.216.73.71/live/{id}` | Indigo origin + Cherry replica ホップの増分 |

```bash
cd web
bun scripts/latency-probe.ts run --minutes 8 --source 'http://127.0.0.1:0/latency-source.html?tones=1' \
  --video-profile quality --player win2022 --notify-discord 1380914078100488334 \
  --node-host chi1.web-screen.net --server-snap webscreen-cherry
```

## 落とし穴

- run ごとに配信 URL は変わる。古い URL は再生できない。**同じ URL を使い回すには `--stream-id {前回の ID}` を付ける**（終了済みで自分が所有する ID だけ）。貼る手間が 1 回で済む
- **貼る前にワールドへ入り直す**。前の配信が終わった直後に貼ると Player Error になり、そのまま run が終わる（2026-09-05 実測: 8 分すべて Player Error）
- **`--player win2022` の前に Windows 側を確認する**（2026-09-05 実測。どれか 1 つでも欠けると録画は「成功」しても標本 0 になる）
  - 物理モニターが点いている（消灯中は gdigrab が最後のフレームを返し続ける。`powercfg /q SCHEME_CURRENT SUB_VIDEO VIDEOIDLE` の AC が 0x78 = 120 秒。run 中は `powercfg /change monitor-timeout-ac 0`、終わったら `2`（分）に戻す）
  - コミット（仮想メモリ）に空きがある（`(Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory`。Docker Desktop の backend が 99 GB 掴んで dwm.exe が落ち、録画も VRChat も止まった。Docker Desktop は終了しておく）
  - プレイヤーを正面から映す（少し斜めでも軸走査の同期パターン探索が外れて `sync-pattern-not-found` になる）
- 前の配信が終わった直後に新しい URL を貼ると Player Error になることがある。ワールドに入り直してから貼る
- Windows 側の遅延の絶対値は録画時間基準に約 1 秒のオフセットがあり得る（frame 番号 / 30 fps で復元しているため）。同じ run 内の A と B の相対比較に使う
- 連続 run の間は 20 秒以上空ける。残留 Chrome は `pgrep -f webscreen-harness/chrome-profile` で確認する
