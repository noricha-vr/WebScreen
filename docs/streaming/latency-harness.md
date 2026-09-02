# 配信遅延ハーネス

`web/scripts/latency-probe.ts` は、実Mac Chromeの画面共有を自動開始し、配信元→RTSPT出口を時系列で記録する。計測方法の背景と低遅延入力設定は [I19](verification.md#i19-約3秒に見えた-rtspt-遅延を配信経路と受信側に分離2026-09-01) を参照。

```bash
cd web
# 初回のみ、ハーネスのChromeでログインしてCookieを保存
bun scripts/latency-probe.ts login
bun scripts/latency-probe.ts run --minutes 3 --source 'http://127.0.0.1:0/latency-source.html?tones=1'
# 実行中に共有タブを切替
bun scripts/latency-probe.ts source --url https://example.com/
# 保存済みCSVを再集計
bun scripts/latency-probe.ts analyze docs/tmp/latency/<UTC timestamp>
```

- 初回だけ既定プロファイル `~/.webscreen-harness/chrome-profile` で `bun scripts/latency-probe.ts login` を実行し、開いたChromeでWebScreenへ手動ログインする。未ログイン時は開始せず終了する。
- `--source` の `127.0.0.1:0` は起動時の空きポートへ置換される。`?tones=1` はステレオ定常トーンも加える。
- 結果は `outlet.csv` と `summary.md`。`--player win2022` 指定時はWindows録画を回収・復号して `player.csv` を作る。失敗・未復号は `player-error.md` に明記する。
- `ffmpeg` と `ffprobe` が必要。`--player` にはさらに `ssh`、Windows側ffmpeg、VRChatを表示した対話desktopが必要。

制限: v1の必須範囲はRTSPT出口。Windows側はgdigrabの30 fpsフレーム番号から録画時刻を復元するベストエフォートで、dshow音声・ddagrabは未実装。外部URLへ切り替えた後は時刻ブロックがないため、出口遅延の標本は記録されない。

## 既知の失敗と診断ファイル

- 出口が止まっても指定時間まで待機し、`outlet-ffmpeg.log` と `outlet-decode.log` にffmpeg・復号状態を残す。
- `frames/` の最初/最後の復号フレームと直近の失敗フレームで、配信映像を目視確認できる。
- `outlet-audio.wav` と `outlet-audio.json` は `analyze` 時に再検出され、`outlet-audio.csv` と既存の映像行を結合して `summary.md` を再生成する。毎秒ビープは `600 + 100 * (UTC秒 mod 8)` Hz の8種類で、絶対遅延を映像近接標本から復元できない時は `audio_latency_phase_ms`（1秒位相）のみを残す。
- Windows録画は対話セッションのScheduled Taskを使う。失敗時は `player-error.md`、成功時の時刻・`w32tm`補正は `player-recording.md` を見る。

## 出口の測り方と既知のアーティファクト（2026-09-02）

- 出口の映像遅延は **単発取得**（`ffmpeg -frames:v 1` を約 4 秒間隔で繰り返し、取得完了時刻 − フレーム内時刻を上限値、取得開始時刻 − フレーム内時刻を下限値）で測る。`outlet-decode.log` の `grab=N lower=… upper=…` が生値
- 連続 ffmpeg（`-vf fps=5` や `-use_wallclock_as_timestamps`）は起動時の PTS ギャップと内部バッファで古さを引きずり、実遅延 0.8 秒が 2〜6 秒に見えた。映像の連続取得は使わない（音声は連続取得で WAV に保存し `analyze` で検出）
- `--server-snap HOST` は run 中にサーバーへ SSH し、ingress（8554）と egress（554）を**並列起動**で単発取得して `server-snap.md` に出す。ingress の値が「配信元 → ingress」、egress との差が relay の寄与
- 実測（2026-09-02、計測ページ 1150x720 / 250 ms 更新）: ingress 約 0.55 秒、egress 約 0.80 秒（上限値）、Mac からの出口単発取得 約 0.78 秒。開始直後から安定し、出口に「数秒 → 1 秒未満」の収束は無い
- `--notify-discord CHANNEL_ID` で配信 URL を Discord に投稿する（VRChat を動かす別 PC で貼るため）。`--player win2022` の録画は Scheduled Task 経由で、MacType 導入機では互換性ダイアログが出るが録画は継続する

## 実測前の確認手順（2026-09-02 追記）

1. `bun scripts/latency-probe.ts login`（初回のみ。ハーネスが開く Chrome でログイン）
2. `bun scripts/latency-probe.ts player-check --seconds 8`（配信なしで Windows 録画・回収だけを試す。録画長が指定の 80% 以上で OK。フレームに PowerShell コンソールや MacType 警告が写らないこと）
3. `make latency-probe MIN=4 SOURCE=... PLAYER=win2022 NOTIFY_DISCORD=<channel> SERVER_SNAP=<host>`
4. Discord の URL を VRChat に貼り、**プレイヤーを正面に近い視点で**映し続ける（斜めになると復号できない）
