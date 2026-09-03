# VRChat 実機 A/B 検証の手順（コピペ用）

画面共有の設定候補を VRChat 実機で比べる時の固定手順。計測装置の詳細は [latency-harness.md](latency-harness.md)、結果の記録先は [verification.md](verification.md)。

## 固定値

| 項目 | 値 |
|---|---|
| 配信元（計測ページ） | `http://127.0.0.1:0/latency-source.html?tones=1`（ms 時刻のブロックコード + 毎秒ビープ。`?load=heavy` は帯域飢餓の最悪素材） |
| 配信 URL の通知先 | Discord「通知」チャンネル `1380914078100488334`（skill `discord-mention` の既定） |
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

- `--ab-cycle 120` で quality → realtime → … を 2 分ごとに切り替える（6 区間）。`--max-bitrate` は realtime 区間の上限
- 単一プロファイルで測る時は `--ab-cycle` を外し、`--video-profile quality` または `--video-profile realtime --max-bitrate 1500000`

## 落とし穴

- run ごとに配信 URL は変わる。古い URL は再生できない
- 前の配信が終わった直後に新しい URL を貼ると Player Error になることがある。ワールドに入り直してから貼る
- Windows 側の遅延の絶対値は録画時間基準に約 1 秒のオフセットがあり得る（frame 番号 / 30 fps で復元しているため）。同じ run 内の A と B の相対比較に使う
- 連続 run の間は 20 秒以上空ける。残留 Chrome は `pgrep -f webscreen-harness/chrome-profile` で確認する
