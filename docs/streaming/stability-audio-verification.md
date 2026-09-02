# 配信安定性・音声の設定と実測（2026-09-01）

Qiita の「配信が不安定な時」の OBS 設定を比較対象にし、WebScreen のブラウザ配信で採用した値と既存実測を記録する。
記事の画像は OBS / RTMP / NVENC 向けなので、そのまま WebRTC / WHIP へ移植せず、目的が同じ項目だけ対応づける。

参照: [超簡単にTopazChatの使い方（VRchatでみんなに自分のPC画面を観てもらう方法）](https://qiita.com/masahanami002/items/229730be0be0e4b5bacc)
（参照日: 2026-09-01）

## 設定の比較と採用値

| 項目 | 記事の OBS 設定 | WebScreen の採用値 | 判断 |
|---|---|---|---|
| 解像度 | 1920x1080 | **入力 1280x720** | 1.5 Mbps 以下でフレームレートを保つため入力画素数を抑える |
| フレームレート | 60 fps | **30 fps** | 実Macの各600秒比較で30 fpsは29.853 fps・約564.6 kbps・quality limitationなし。24 fpsは23.870 fpsで、平均QPも30 fpsの20.76が24 fpsの21.41よりわずかに良く、1.2 Mbps内なので30 fpsを採用 |
| 映像 | NVIDIA NVENC H.264 | **ブラウザ WebRTC の H.264** | 実装は違うが、VRChat 互換の H.264 を優先固定する目的は同じ |
| レート制御 | CBR | **`maxBitrate = 1_200_000`** | WebRTC は内容と回線に応じて変動する。1.2 Mbps は CBR ではなく映像送出上限 |
| ビットレート | 1000 kbps | **映像 1200 kbps + 音声 128 kbps（公称合計 1328 kbps）** | 実測出口 1.385 Mbps で、1.5 Mbps 上限から 115 kbps の余裕を確保した |
| 劣化方針 | OBS プリセット P7 / 高品質 | **`contentHint = 'detail'` + `maintain-resolution`** | I18 の本番 relay 合成QAで、文字可読性と動画安定性が合格 |
| スケール | — | **`scaleResolutionDownBy = 1`** | I18 で動画像区間の送出解像度を1280x720に維持 |
| キーフレーム | 0 秒（自動） | **通常はMediaMTXのPLIにより約2秒** | MP3 betaのChromeだけ500 ms周期で次キーフレームを要求。first-packet IDRは保証しない |
| 音声 | FFmpeg AAC、音声トラック 1 | **タブ音声 → WebRTC 音声 → AAC-LC 48 kHz / stereo / 128 kbps。Chrome の音声処理は切る（EC/NS/AGC=false, contentHint 'music'）** | Chrome で「タブの音声を共有」をオンにした時だけ音声を付ける |

採用設定値の正本は `web/src/lib/ui/screen-share/video-profile.ts`、送出への適用は `web/src/lib/ui/whip-publisher.ts`。本番 relay の合成 motion/static QA は合格したが、WebScreen UI からの actual YouTube 最終確認は未実施。
full設定がブラウザに拒否された時はfresh parametersからmaxBitrate-only fallbackを1回だけ試す。これは配信継続の互換策であり、文字品質を保証しない。

## 実測条件

- 配信元: 実 Google Chrome 152.0.7977.65 内の 1280x720 canvas
- 動き: Wikipedia 富士山ページの実スクリーンショットを 240 px/秒で往復スクロール
- 音声: 440 Hz テスト音。30 fps / 24 fps の各候補で同じ素材を使用
- 経路: ブラウザ → WebRTC / WHIP → Indigo ingress → ffmpeg relay → Indigo egress → RTSP/TCP
- 測定: browser outbound stats、ingress / egress の `bytesReceived` 差分、RTSP 出口 fps、freeze、ffprobe、5秒音声を確認
- **実際の YouTube タブではなく代表素材による比較**。過去の YouTube 実機観測とは区別する

## 既存の代表素材比較

次の数値は `motion` / `maintain-framerate` で測った既存比較であり、現行設定の合否には使わない。

| fps / 映像上限 | browser fps | RTSP fps | freeze | ingress | total egress | 判定 |
|---|---:|---:|---:|---:|---:|---|
| 30 / 1.1 Mbps | 30.02 | 27.75 | 0 | 1.183 Mbps | 1.279 Mbps | 最低合格 |
| **30 / 1.2 Mbps** | **30.01** | **29.96** | **0** | **1.291 Mbps** | **1.385 Mbps** | **既存比較の候補。1.5 Mbps から 115 kbps の余裕** |
| 30 / 1.3 Mbps | 30.01 | 27.67 | 0 | 1.396 Mbps | 1.501 Mbps | 上限超過 |
| 24 / 1.1 Mbps | 24.01 | 22.49 | 0 | 1.168 Mbps | 1.260 Mbps | 不採用 |
| 24 / 1.2 Mbps | 24.00 | 22.12 | 0 | 1.292 Mbps | 1.389 Mbps | 不採用 |
| 24 / 1.3 Mbps | 24.02 | 22.97 | 0 | 1.401 Mbps | 1.491 Mbps | 23 fps 未満かつ余裕不足 |

全候補で H.264 Baseline / yuv420p / B フレーム 0 と AAC-LC / 48 kHz / stereo を確認した。5秒音声は
mean 約 -27.5 dB、max 約 -24 dB、RMS 約 -27.45 dB で非無音だった。入力 canvas は 1280x720 だが、
Chrome の `maintain-framerate` 帯域適応により今回の実送出と RTSP 出口は **960x540**。入力要求値を実送出解像度として扱わない。

## 採用設定の本番 relay 合成QA（I18・2026-09-01）

1280x720 / 30 fps / maxBitrate 1.2 Mbps / `detail` / `maintain-resolution` / scale 1 / H.264優先 / 48 kHz stereo で測定した。

| phase | RTSP | freeze | video | total egress |
|---|---|---:|---:|---:|
| A motion（120秒） | 1280x720 / 30.00 fps | 0 | 0.899 Mbps | 1.037 Mbps |
| B static（60秒） | 1280x720 / 30.00 fps | 59.999秒（意図した静止） | 0.264 Mbps | 0.397 Mbps |
| C motion（120秒） | 1280x720 / 30.06 fps | 0 | 0.896 Mbps | 1.035 Mbps |

H.264 Baseline / yuv420p / B フレーム 0、AAC-LC / 48 kHz / stereo、音声 mean -25.0 dB の非無音を確認した。16 / 24 px文字は明瞭、12 pxも判読可能。
raw の A freeze 1.000秒とB 58.999秒はRTSP接続がsource phaseより約1秒遅れた境界差であり、source phase補正後のA/Cはfreeze 0。Cで解像度・fpsは回復した。
1.25 Mbps は不要と判断し未試験。cleanupではchecksum不変、認証除外の復元、両pathの404、remote一時ファイル0を確認した。

## actual YouTube 実機確認（2026-09-01）

代表素材の候補比較とは別に、actual YouTube を音声共有ありで本番 relay と VRChat PC 実機へ配信して確認した記録。

### 合格・証明済み

- ユーザー実機では**音声付きで安定**。開始直後には少しカクついたが、約30秒で自然に安定した。
- 本番サーバーでは配信 path が計 **14分25秒以上 active** で、途中切断はなかった。
- RTSP 出口は H.264 Constrained Baseline / yuv420p / B フレーム 0、音声は AAC-LC / 48 kHz / stereo。
- 音声は mean **-19.9 dB**、max **-7.6 dB** で非無音。したがって、本番で AAC 音声が聞こえることを確認済み。

### 保留・再測定が必要なこと

10分06秒の全体集計は ingress 0.582 Mbps、total egress 0.611 Mbps、12.16 fps、freeze 25回 / 333.657秒、480x270 だった。
ただし測定中に Big Buck Bunny が終了し、後半の静止画が集計へ混入している。動画終了時刻ごとの帯域・fps・freeze の時系列は保存しておらず、
動画像区間だけの数値を復元できない。この全体集計は **1.0〜1.5 Mbps 条件の合否や映像安定性の判定に使わない**。

文字が不可読だった観測では 274x148、1.78 fps、total egress 0.064 Mbps だった。動画像終了後の静止画では低い実効ビットレートは正常なため、
この低実効値だけを合否に使わない。

残る最終確認は、採用設定を本番WebScreen UIから actual YouTube へ適用し、動画像区間に限定した fps・freeze・帯域と文字可読性を確認すること。
開始直後のカクつきは自然回復したため、一律の「カクついたら再起動」注記は追加しない。relay 未到達時だけ再接続する現行方針を維持する。

本番のログイン済みタブを安全に自動操作できなかったため、測定時だけランダムな1 path を JWT 検証の除外対象にし、製品と同じ
WHIP / H.264優先 / 候補ごとの上限 / relay経路へ直接 publish した。測定後は除外設定を元に戻し、設定ファイルの
checksum が不変、ingress / egress のテスト path が 404、remote の一時ファイルが削除済みであることを確認した。

## 再起動の案内方針

画面へ一律に「カクつく場合は再起動してください」とは書かない。再起動で偶然直る症状と、ビットレート不足によるコマ落ちを
区別できず、利用者へ原因調査を押しつけるため。

代わりに実装で次を行う。

1. 配信開始後、ingress と egress の受信 bytes がどちらも連続して増えるまで URL を表示しない。
2. 10 秒で到達しなければ、選択済みの画面を保ったまま WHIP を 1 回だけ自動再接続する。
3. それでも到達しなければ「配信サーバーへ再接続」ボタンを出す。画面の選び直しは不要。
4. 画面共有自体が終了した場合だけ、ブラウザの制約により利用者がもう一度画面を選ぶ。

この設計により、再起動は一般的な注意書きではなく、実際に relay 未到達を検知した時だけ行う回復操作になる。

MP3 betaの20回途中参加ではfirst packet Kが3/20、non-Kが17/20、次キーフレームまで0〜463 msだった。decoder probeは初期missing-reference警告後も継続した。開始直後のカクつきや約30秒後の安定は、常設の再起動案内ではなく初動buffer / decoder recoveryの観測として扱う。

MP3 48 kHz stereo 128 kbpsは30分・非無音・A/V 7〜15 msまで自動確認済みで、「めっちゃ速い」との観測がある。実Mac 24/30 fps比較では30 fpsを採用した。ただし本番へ一時投入した際はPC実機でMP3音声が無音で、AACへ戻すと聞こえた（[verification.md](verification.md) I23）。MP3候補は昇格しない。

## 音声の確認境界

- 画面選択前に「Chrome でタブを選び、タブの音声を共有をオンにする」と案内する。
- 選択結果に音声トラックがあれば「音声を含めて配信しています」、なければ「映像のみ」と表示する。
- relay 出口は現行でH.264 + AAC、MP3 beta候補でH.264 + MP3を `verify-codecs.sh` で検証する。
- 表示文言は **「検証時に音声が出ることを確認済み」** とし、PoC という表現は使わない。
- Chromeの音声処理（EC / NS / AGC）がモノラル化の原因だったため、**rawが既定**になった（ブラウザ取得側の設定で、relay の `audio-profile.sh` とは別物）。2026-09-02の本番A/Bで、legacy（処理あり）は出口のL−Rが−91 dBの完全モノラルだったのに対し、rawは−57.6 dB（本体 −32.6 dB との差 25 dB）でステレオ成分が残り、実聴でもステレオを確認した。
- `?audio-profile=legacy` は旧挙動へ戻す退避経路。rawが原因かを切り分ける時と、rawで問題が出た配信環境の一時回避に使う。
- A/Bでは同じ共有元でrawとlegacyを各5秒測り、`ffmpeg -rtsp_transport tcp -i rtsp://webscreen.tv/live/{id} -t 5 -vn -af "pan=mono|c0=0.5*c0-0.5*c1,volumedetect" -f null -` を実行する。L−R差分が本体（`volumedetect` 単独）より 40 dB 以上低ければモノラルとみなす（2026-09-02 の legacy 実測は本体 −21 dB に対し L−R −91 dB）。
- 測定境界: 出口は relay が `-ac 2 -b:a 128k` で再エンコードした後なので、判定できるのは**モノラルかどうか**まで。Opus の `maxaveragebitrate` や高域の差は出口に届かないため、高域比較は ingress（`rtsp://127.0.0.1:8554`、サーバー内）で測る。
- 取得側の `audio_capture_settings` ログ（`profile` は `raw` / `legacy`、channelCount / EC / NS / AGC）は両方で出るので、A/Bではこれも並べて比較する。raw で `raw_audio_sender_bitrate_failed` が出た時は 128 kbps 未適用として記録する。
