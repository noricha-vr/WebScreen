# 配信遅延ハーネス

`web/scripts/latency-probe.ts` は、実Mac Chromeの画面共有を自動開始し、配信元→RTSPT出口を時系列で記録する。計測方法の背景と低遅延入力設定は [I19](verification.md#i19-約3秒に見えた-rtspt-遅延を配信経路と受信側に分離2026-09-01) を参照。

```bash
cd web
bun scripts/latency-probe.ts run --minutes 3 --source 'http://127.0.0.1:0/latency-source.html?tones=1'
# 実行中に共有タブを切替
bun scripts/latency-probe.ts source --url https://example.com/
# 保存済みCSVを再集計
bun scripts/latency-probe.ts analyze docs/tmp/latency/<UTC timestamp>
```

- 初回だけ既定プロファイル `~/.webscreen-harness/chrome-profile` でWebScreenへ手動ログインする。未ログイン時は開始せず終了する。
- `--source` の `127.0.0.1:0` は起動時の空きポートへ置換される。`?tones=1` はステレオ定常トーンも加える。
- 結果は `outlet.csv` と `summary.md`。`--player win2022` 指定時はWindows録画を回収・復号して `player.csv` を作る。失敗・未復号は `player-error.md` に明記する。
- `ffmpeg` と `ffprobe` が必要。`--player` にはさらに `ssh`、Windows側ffmpeg、VRChatを表示した対話desktopが必要。

制限: v1の必須範囲はRTSPT出口。Windows側はgdigrabの30 fpsフレーム番号から録画時刻を復元するベストエフォートで、dshow音声・ddagrabは未実装。外部URLへ切り替えた後は時刻ブロックがないため、出口遅延の標本は記録されない。

## 既知の失敗と診断ファイル

- 出口が止まっても指定時間まで待機し、`outlet-ffmpeg.log` と `outlet-decode.log` にffmpeg・復号状態を残す。
- `frames/` の最初/最後の復号フレームと直近の失敗フレームで、配信映像を目視確認できる。
- `outlet-audio.wav` と `outlet-audio.json` は `analyze` 時に再検出され、`outlet-audio.csv` を再生成する。
- Windows録画は対話セッションのScheduled Taskを使う。失敗時は `player-error.md`、成功時の時刻・`w32tm`補正は `player-recording.md` を見る。
