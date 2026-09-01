# VRChat 実機での受け入れテスト

新規構築時と配信経路の変更後に実施する回帰テスト。ここが落ちると設計ごと変わるため、コードの単体テストだけで完了にしない。

ローカルでの検証は完了している（[verification.md](verification.md)）。残っているのは「VRChat 実機で本当に映るか」で、
ワールド 1 つでまとめて潰せる。

## 準備

1. VPS を 1 台用意する（検証だけなら最安で足りる。帯域は使わない）
2. [poc/](poc/) 一式を置き、グローバル IP で MediaMTX を起動する
3. **MediaMTX は v1.20.1 から試す**（バージョンの大きい方から。ダメなら v1.15.5 へ落とす）
4. AVPro の **Stream モード**を持つワールド（ProTV 等）を用意する
5. ブラウザから WHIP で publish できることを確認する

> **ポート**: WHIP は UDP（既定 8189/udp）が配信者から直接届く必要がある。Cloudflare の裏には置けない。

## 手順

| # | 手順 | 合格基準 | 落ちた場合 |
|---|---|---|---|
| **A1** | ブラウザから WHIP publish し、`ffprobe` で RTSP を取得 | `codec_name=h264` / `profile=Baseline` / `pix_fmt=yuv420p` / `has_b_frames=0` | ローカルと同じなので通るはず。通らなければ NAT / ポートを疑う |
| **A2** | Private / Friends / Friends+ / Public で `rtspt://webscreen.tv/live/{id}` を貼る | Private / Friends / Friends+ は視聴者の `Allow Untrusted URLs` が ON。Public は**視聴者の同設定が ON**かつ**ワールド作者が Allowed Domains に `webscreen.tv` を登録済み**なら映像が出る | reader が 0 本なら RTSP 前の許可設定を確認する。relay / codec を先に疑わない |
| **A3** | 個別のPCワールドで遅延を実測 | **音声付きで1秒以下**。同じYamaStreamのRTSPT H.264/MP3候補は16標本すべて1秒未満（中央値0.151秒）。音声が聞こえた手動観測はあるが、同じ統制測定内の実聴ではないため判定保留。AACは独立2回とも中央値1.239秒で未合格 | NTP補正済み時計を使い、映像のみ／音声付きの条件を分ける。Quest確認前に本番昇格しない |
| **A4** | `Use Low Latency` の実値を確認できるワールドで遅延を実測 | 設定値と映像のみ／音声付きの遅延を記録する（現行の合格値は未設定） | RTMPは現行YamaStreamのMedia Foundation経路でLoading failedとなりA/B不能。過去値との差をプロトコル差と断定しない |
| **A5** | **5 分以上再生を維持** | **60 秒で切断しないか** | 切れる場合、視聴者数ぶんの再接続が毎分走りスケールに直撃する。バージョンを変えて再試行 |
| **A6** | 途中から URL を貼り直す | 通常は2秒以内。MP3 betaは次キーフレームまで500 ms以内を目標とし、初期non-K後の復旧も確認する | first packetのIDRは要求しない。MediaMTXにGOP cacheはない |
| **A7** | Quest 実機で PC と同じ `rtspt://webscreen.tv/live/{id}` を貼る | 映像と AAC 音声が出るか。現状境界の体感 2〜3 秒を記録する | URL は分岐しない。Quest の 1 秒未満はサーバー設定だけで保証しない |
| **A8** | A2 の許可設定を通過し egress reader 接続後に、v1.20.1 で再生失敗または切断が出た時だけ v1.15.5 で再試行 | **どちらを採用するか決める** | 許可拒否・reader 0 本では降格しない。許可設定とRTSP接続が成立した後の再生失敗／切断だけをMediaMTX版の比較対象にする |
| **A9** | Chrome でタブと「タブの音声を共有」を選ぶ | UI が音声ありと表示し、出口が H.264 + AAC になる | audio track、relay の ffmpeg、egress の順に切り分ける |
| **A10** | ingress または relay を一時的に未到達にして開始する | 同じ画面で 1 回自動再接続し、失敗時だけ再接続ボタンを出す | 一律の「再起動してください」案内へ逃げず、health bytes を確認する |
| **A11** | actual YouTube を開始して直後のカクつきを観察する | 約 30 秒待って安定すること。継続時は ingress / egress bytes を確認し、relay 未到達の場合だけ再接続する | 到達済みなら再接続を合格手順にしない。無条件の再起動は勧めない |
| **A12** | MP3 relayを本番候補として昇格判定する | `?stream-profile=mp3-beta` を重複なく指定し、PCとQuestでMP3音声を実聴して各1秒未満を確認する。30分・20 relay・20 reader・codec gateは合格済み。残る実Mac動的映像の30 / 24 fps比較を完了する | 「音声が聞こえた」「めっちゃ速い」は有力な手動観測だが、PC/Questを分けた統制済みA12測定ではない。1項目でも未確認ならAACを維持する |

## 測定の方法

遅延（A3 / A4）は、[poc/whip-publisher.html](poc/whip-publisher.html) が画面にミリ秒時刻を大きく描画しているので、
**VRChat の画面と配信元の画面を同時に撮影して差を読む**。今回使ったNTP時計は大時計自体が補正済みであり、下段の端末ずれを時計差から重ねて引かない。配信元から RTSPT 出口までの切り分けでは、オンライン時計を送出し、出口で `-use_wallclock_as_timestamps 1`、`-copyts`、`-frame_pts 1` を用いて別に読む（[verification.md](verification.md) I19）。

## この後に決めること

受け入れテストが通ったら、技術ではなく製品方針として次を決める。

| 論点 | 補足 |
|---|---|
| PC の遅延をどう訴求するか | YamaStream単一ワールドをPC全般へ一般化しない。AACは中央値1.239秒、MP3候補は中央値0.151秒で分ける。MP3はA12が未合格のため、本番はAACを維持する |
| Quest を出すか | PC と同じ `rtspt://webscreen.tv/live/{id}` で映像・AAC 音声を確認済み。URL は共通にし、「Quest は現状 2〜3 秒」と明示する。サーバー設定だけで 1 秒未満は約束しない |
| 同時配信本数の上限 | ユーザー在席型ならサーバー CPU をほぼ使わないので path 数の管理だけで済む |
| 配信の再開 | 取得済み画面の WHIP 再 publish は 1 回自動で行う。画面共有そのものが終了した時だけ、ユーザー操作で選び直す |
| `../encode-contract.md` の境界 | VOD は FFmpeg.wasm 1 系統。ライブはブラウザ H.264 + server relay の音声 AAC 変換を別契約として扱う |
