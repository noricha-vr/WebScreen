# 配信遅延ハーネス

VRChat 実機での A/B（人の手順と固定コマンド）は [vrchat-ab-runbook.md](vrchat-ab-runbook.md) を先に見る。

`web/scripts/latency-probe.ts` は、実Mac Chromeの画面共有を自動開始し、配信元→RTSPT出口を時系列で記録する。計測方法の背景と低遅延入力設定は [I19](verification.md#i19-約3秒に見えた-rtspt-遅延を配信経路と受信側に分離2026-09-01) を参照。

```bash
cd web
# 初回のみ、ハーネスのChromeでログインしてCookieを保存
bun scripts/latency-probe.ts login
bun scripts/latency-probe.ts run --minutes 3 --source 'http://127.0.0.1:0/latency-source.html?tones=1'
# quality既定と realtime を同じ素材・同じ窓でA/B比較する例
bun scripts/latency-probe.ts run --minutes 3 --source 'http://127.0.0.1:0/latency-source.html?load=heavy' --video-profile quality
bun scripts/latency-probe.ts run --minutes 3 --source 'http://127.0.0.1:0/latency-source.html?load=heavy' --video-profile realtime --max-bitrate 1500000
# 実行中に共有タブを切替
bun scripts/latency-probe.ts source --url https://example.com/ --scroll 240
# 保存済みCSVを再集計
bun scripts/latency-probe.ts analyze docs/tmp/latency/<UTC timestamp>
```

- 初回だけ既定プロファイル `~/.webscreen-harness/chrome-profile` で `bun scripts/latency-probe.ts login` を実行し、開いたChromeでWebScreenへ手動ログインする。未ログイン時は開始せず終了する。
- `--source` の `127.0.0.1:0` は起動時の空きポートへ置換される。`?tones=1` は左右チャンネル確認用の小さな持続音（220 / 330 Hz、ゆっくり揺らぐ）も加える。
- 計測ページは復号用の格子の左に秒針つきアナログ時計、右に `HH:MM:SS.mmm`（配信元 PC のローカル時刻）を描く。VRChat 実機で隣にブラウザの同じページ（または任意の時計）を並べれば、Windows 全画面録画のフレームから目視でも遅延を読める。どちらも格子の隔離矩形の外に描くので復号には影響しない（plain / heavy / 800x600 で確認済み）
- 結果は `outlet.csv` と `summary.md`。送出側の生counterは `sender.csv`、共有ページで実際に使われたsender/track設定は `sender-config.json` に保存する。設定取得に失敗してもJSONに理由を残す。
- 出口画質は遅延用の単発取得と別の連続ffmpegで測り、`outlet-quality.csv`（fps・解像度・freeze・実効ビットレートの窓別値）と `outlet-quality.md`（窓数・freeze・解像度変化の要約）を出す。既定の窓は20秒で、`--outlet-quality-seconds 5..120`で変えられる。失敗時は `outlet-quality.log` に理由を残しrunを失敗にする。
- `--video-profile quality`（既定）は通常の共有ページを開く。`--video-profile realtime --max-bitrate 1200000|1500000|2000000` はproduction共有ページへ設定queryを渡す（省略時は1500000）。`--ab-cycle`なしで`--max-bitrate`をqualityと併用したり許可外の値を指定すると開始前に失敗する。
- `--ab-cycle 60..600 --max-bitrate 1200000|1500000|2000000` は、開始プロファイルからquality/realtimeを自動往復する。VRChatでは配信URLを1回貼るだけでABAB比較できる。
- 切替履歴は `profile-switches.csv`（UTC時刻・経過秒・プロファイル・ビットレート）に保存され、`summary.md` の「プロファイル区間別」は切替後15秒を除外して区間別とquality/realtimeプールを集計する。
- `--scroll 0..2000` は `run` と `source` で使える。外部ページだけを指定速度（px/秒）で末尾で反転する往復スクロールにし、計測ページには適用しない。I9との比較は `--scroll 240` を使う。
- `latency-source.html?load=heavy` は外部取得なしの写真調グラデーション・広い変化領域・連続移動カーソルを描く高負荷素材。ブロックコードは独立した高コントラスト領域に置くため、縮小しても遅延復号を維持する。
- `--player win2022` 指定時はWindows録画を回収・復号して `player.csv` を作る。失敗・未復号は `player-error.md` に明記する。
- `ffmpeg` と `ffprobe` が必要。`--player` にはさらに `ssh`、Windows側ffmpeg、VRChatを表示した対話desktopが必要。

制限: v1の必須範囲はRTSPT出口。Windows側はgdigrabの30 fpsフレーム番号から録画時刻を復元するベストエフォートで、dshow音声・ddagrabは未実装。外部URLへ切り替えた後は時刻ブロックがないため、出口遅延の標本は記録されない。

## 別ノードを origin にして測る（`--node-host`）

`--node-host chi1.web-screen.net` を付けると、本番 Worker の `STREAM_WHIP_ORIGIN` と DNS を変えずに、このハーネスの配信だけを指定ノードへ送る。

- 配信開始 / 再利用 API の応答に含まれる `whipUrl` のホストだけを Playwright の `route` で差し替える（パス `/live/{id}/whip` と https は維持。publish JWT は本番 Worker が署名したものをそのまま使うので、ノード側の ingress は本番 JWKS を参照していれば受け付ける）
- 指定できるのは `web-screen.net` 配下の 1 ラベル（`chi1.web-screen.net` 形式）だけ。本番 Worker が発行した publish JWT を送る先なので、自前ドメイン外・IP・localhost は拒否する
- 画面の health 待機は本番 Worker が本番 origin（Indigo）の MediaMTX を見るため、別ノードへ publish すると永遠に starting のままになる。ハーネスは `/api/streams/{id}/health` を「呼ばれるごとに egress が増える ready」の合成応答に差し替え、実際の到達確認は出口 ffmpeg（`probeDimensionsFor` / 単発取得）が担う。出口が取れなければ run は失敗する
- 出口計測（`ffmpeg` の単発取得・音声・画質）と Discord に流す視聴 URL も `rtsp(t)://<node-host>/live/{id}` になる。VRChat にはこの URL を貼る（`webscreen.tv` と同じく allowlist 外なので条件は同じ）
- `--server-snap` は別指定（例 `--server-snap webscreen-cherry`）。ノードの SSH alias を渡す
- 使った host は `sender-config.json` の `harnessNodeHost` / `harnessReadHost` に残る
- `--read-host HOST[:PORT]` で視聴先だけを別に指定できる（`--node-host` と併用して「A に配信、B から視聴」を測る。web-screen.net 配下の 1 ラベル + 任意ポート）。ポート付きは自宅回線から届かないことがある（2026-09-04 に 5554 が不通。554 は通る）ので、届かない時はノード側でポートを入れ替える
- ノード側の前提: ingress + relay が動き、Caddy がそのホストで WHIP ルートを持ち（`web/streaming/Caddyfile.node`）、cron の `MEDIAMTX_READ_EGRESS_API_URLS` にそのノードの Control API が入っていること。入っていないと本番 cron が「viewer 0」と判定し、`STREAM_NO_VIEWER_SECONDS`（600 秒）で配信を終了させる

## 既知の失敗と診断ファイル

- 出口が止まっても指定時間まで待機し、`outlet-ffmpeg.log` と `outlet-decode.log` にffmpeg・復号状態を残す。
- `frames/` の最初/最後の復号フレームと直近の失敗フレームで、配信映像を目視確認できる。
- `outlet-audio.wav` と `outlet-audio.json` は `analyze` 時に再検出され、`outlet-audio.csv` と既存の映像行を結合して `summary.md` を再生成する。毎秒ビープは `600 + 100 * (UTC秒 mod 8)` Hz の8種類で、絶対遅延を映像近接標本から復元できない時は `audio_latency_phase_ms`（1秒位相）のみを残す。
- Windows録画は対話セッションのScheduled Taskを使う。ssh はタスクの起動と、20 秒間隔の短い done マーカー読みだけに使う（1 本の ssh で録画時間ぶんブロックする方式は 8 分 run で出力なしの exit 1 になり録画を失った。2026-09-04）。失敗時は `player-error.md`、成功時の時刻・`w32tm`補正は `player-recording.md` を見る。
- run 終了時は共有ページの停止ボタンを押してから Chrome を閉じる。`browser.close()` だけでは停止ビーコンが届かず配信がサーバーに残り、次の run が「既存の配信を終了」経路に入って不安定になる（2026-09-02 に連続 8 run 中 3 run が失敗）。Playwright がクラッシュして Chrome が残った時も同じ状態になるので、`pgrep -f webscreen-harness/chrome-profile` で残留を確認してから始める
- `page.evaluate` に渡す関数はシリアライズされるため module scope の helper を参照できない（`ReferenceError` になり 1 秒標本が 0 件になる）。閉包内に定義する
- ffmpeg の `-t` は直後の出力にしか効かない。出力を 2 本持つ画質計測では両方に付けないと終わらず run 全体が固まる
- `?load=heavy` は色ノイズのモザイクをパンする **最悪ケース**で、A（1.2 Mbps / maintain-resolution）では出口 1 fps・freeze 15 秒/20 秒まで落ちる。実ページ相当の負荷は Wikipedia の `--scroll 240` で測り、heavy は帯域飢餓時の挙動比較にだけ使う（2026-09-02 実測）

## 出口の測り方と既知のアーティファクト（2026-09-02）

- 出口の映像遅延は **単発取得**（`ffmpeg -frames:v 1` を約 4 秒間隔で繰り返し、取得完了時刻 − フレーム内時刻を上限値、取得開始時刻 − フレーム内時刻を下限値）で測る。`outlet-decode.log` の `grab=N lower=… upper=…` が生値
- 連続 ffmpeg（`-vf fps=5` や `-use_wallclock_as_timestamps`）は起動時の PTS ギャップと内部バッファで古さを引きずり、実遅延 0.8 秒が 2〜6 秒に見えた。映像の連続取得は使わない（音声は連続取得で WAV に保存し `analyze` で検出）
- `--server-snap HOST` は run 中にサーバーへ SSH し、ingress（8554）と egress（554）を**並列起動**で単発取得して `server-snap.md` に出す。ingress の値が「配信元 → ingress」、egress との差が relay の寄与
- 実測（2026-09-02、計測ページ 1150x720 / 250 ms 更新）: ingress 約 0.55 秒、egress 約 0.80 秒（上限値）、Mac からの出口単発取得 約 0.78 秒。開始直後から安定し、出口に「数秒 → 1 秒未満」の収束は無い
- `?tones=1` の左右確認用定常音（現行 220/330 Hz、旧 440/880 Hz）は 50 ms 検出窓では秒識別ビープの 8 帯域へ漏れず、検出数・`secondMod8`・onset（±15 ms）を乱さない（回帰: `web/tests/scripts/latency-probe.test.ts` の test.each「定常音 … に重ねても8個の秒識別ビープを取り違えず検出する」。ただし 600〜1300 Hz の各帯域近傍に定常音を足すとグローバル閾値が持ち上がって検出が消えるため（実測: 890 / 900 / 905+1210 Hz で検出 0 件）、確認音の周波数はこの範囲外に置く）
- `--notify-discord CHANNEL_ID` で配信 URL を Discord に投稿する（VRChat を動かす別 PC で貼るため）。`--player win2022` の録画は Scheduled Task 経由で、MacType 導入機では互換性ダイアログが出るが録画は継続する

## 実測前の確認手順（2026-09-02 追記）

1. `bun scripts/latency-probe.ts login`（初回のみ。ハーネスが開く Chrome でログイン）
2. `bun scripts/latency-probe.ts player-check --seconds 8`（配信なしで Windows 録画・回収だけを試す。`--seconds` は 900 まで。録画長が指定の 80% 以上で OK。フレームに PowerShell コンソールや MacType 警告が写らないこと）
3. `make latency-probe MIN=4 SOURCE=... PLAYER=win2022 NOTIFY_DISCORD=<channel> SERVER_SNAP=<host>`
4. Discord の URL を VRChat に貼り、**プレイヤーを正面に近い視点で**映し続ける（斜めになると復号できない）
