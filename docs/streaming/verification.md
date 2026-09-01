# 検証結果（2026-08-29 実測）

2026-09-01 の 1.5 Mbps カクつき観測、2 Mbps の旧測定、30 / 24 fps・1.1〜1.3 Mbps 比較、音声 AAC、relay 到達確認は
[stability-audio-verification.md](stability-audio-verification.md) に分離して記録する。本ファイルの 300〜1500 kbps の測定は
過去の比較データであり、現行設定の正本ではない。

数字の根拠。**V1〜V10 はローカルループバックでの検証であり、VRChat 実機と実ネットワークは含まない**（実機は [acceptance-test.md](acceptance-test.md)）。
実サーバー（Indigo）での実測は「[Indigo 実機検証](#indigo-実機検証2026-08-31-実測issue-91)」節（2026-08-31 追記）。

- 環境: macOS (M3 Ultra) / MediaMTX **v1.15.5** と **v1.20.1** の両方 / Chrome・Safari 26.5.2・Playwright 同梱 Chromium / ffmpeg 8.0.1
- 構成: ブラウザの canvas（1920x1080・30fps・テキスト中心）→ WHIP → MediaMTX → RTSP(TCP) / HLS
- 再現用の一式: [poc/](poc/)

## 結果一覧

| # | 検証項目 | 受け入れ基準 | 実測 | 判定 |
|---|---|---|---|---|
| V1 | RTSP 出力のコーデック契約 | h264 / Baseline / yuv420p / B フレームなし | `codec_name=h264` `profile=Baseline` `pix_fmt=yuv420p` `has_b_frames=0` `1920x1080` | **合格** |
| V2 | 途中参加の待ち時間 | 2 秒以内 | **1.66 / 1.95 / 1.96 秒**（v1.15.5）、**1.88 / 1.98 / 1.99 秒**（v1.20.1） | **合格** |
| V3 | キーフレーム間隔 | 1 秒以下が理想 | **2.00 秒ちょうど**（両バージョン） | **条件付き** |
| V4 | 静止テキストの可読性 | 12px の日本語が読める | **12px まで判読可** | **合格** |
| V5 | 実効ビットレート | 静止時 1 Mbps 以下 | **604〜664 kbps** | **合格** |
| V6 | RTSP と HLS の同時出力 | 両方同時に取れる | 両方 HTTP 200。HLS セグメントも Baseline / yuv420p / B フレームなし | **合格** |
| V7 | RTSP 接続あたりのコスト | 実測値を得る | **1 コアあたり約 125 本**（0.7〜0.9%/reader）、**RAM 約 23 KB/reader** | **測定完了** |
| V8 | 音声 Opus→AAC の変換コスト | 数 % に収まる | **1 コアの 0.77%/配信**（映像 copy）。フル再エンコードの約 1/15 | **合格** |
| V9 | 長時間の RTSP 接続維持 | 60 秒を越えて切れない | **74.3 秒受信、切断なし・エラーなし** | **合格**（ffmpeg での話） |
| V10 | 配信元→RTSP 受信の遅延 | 実測値を得る | **75 / 107 / 113 ms**（定常状態） | **測定完了** |

## 詳細

### V1: 無変換パスは成立する

Chrome が送出したコーデックのネゴシエーション結果:

```
sent codec=video/H264 fmtp=level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f
     w=1920 h=1080 frames=836 keyframes=16
```

`profile-level-id=42001f` は Baseline（profile_idc=0x42）Level 3.1。RTSP 出口の `ffprobe` も `profile=Baseline` / `pix_fmt=yuv420p` / `has_b_frames=0` で、
**`../encode-contract.md` の VRChat 互換必須条件をすべて満たす**。

**サーバー側にトランスコーダを置かずに済む**ことが確定した。これにより「配信 1 本あたり 1〜2 vCPU」の想定が不要になった。

**ただし H.264 の明示指定は必須**（[requirements.md](requirements.md) R1）。既定では VP8 が選ばれ、MediaMTX はそれをエラーにせず素通しする。

### V3: キーフレーム間隔は 2.00 秒固定で、設定で変えられない

MediaMTX は WebRTC publisher へ **2 秒周期で無条件に PLI（キーフレーム要求）を送る**。
reader の接続をトリガーにしたものではなくタイマー固定で、Go の `const`（`keyFrameInterval = 2 * time.Second`）のためコンフィグで変更できない。
v1.15.5 と v1.20.1 のどちらでも実測 2.00 秒ちょうどだった。

連鎖する影響は [requirements.md](requirements.md) に記載。

### V7: 接続あたりのコストは無視できない

CPU 時間の差分で 10 秒ごとに実測（633 kbps のストリームを N 本読ませた）:

| reader 数 | CPU（1 コア = 100%） | RSS |
|---|---|---|
| 0 | 1.1 % | 54.1 MB |
| 20 | 10.0 % | 54.2 MB |
| 40 | 32.7 % | 54.5 MB |
| 60 | 41.9 % | 54.9 MB |
| 80 | **73.7 %** | 55.9 MB |
| 0（全切断後） | 1.6 % | 56.1 MB（リークなし） |

**1 reader あたり 1 コアの 0.7〜0.9%** ＝ **1 コアあたり約 125 本**。メモリは約 23 KB/reader と軽い。

> **測定上の注意**: macOS の `ps -o %cpu` はプロセス起動からの平均値で瞬間値ではない。
> 負荷を段階的に上げる測定では**必ず CPU 時間（`ps -o time`）の差分**を使う。
> %cpu を使った最初の測定では、同じ 60 reader で 48%→62% と値が動き続けて傾きが取れなかった。

この結果が収容人数の計算に効く（[capacity.md](capacity.md)）。

### V10: パイプライン遅延は約 100 ms

canvas に描いたミリ秒時刻を送出し、受信映像に映った時刻と受信時刻の差で測定:

```
試行1: 録画終了 95783 - 表示 95270 = 513 ms → 補正後 113 ms
試行2: 録画終了  4078 - 表示  3571 = 507 ms → 補正後 107 ms
試行3: 録画終了 12411 - 表示 11936 = 475 ms → 補正後  75 ms
```

ここに実ネットワークの RTT と AVPro のバッファが加わる。VRChat での「0.3〜0.5 秒」という値と矛盾しない。

### V9: 60 秒切断は再現せず

75 秒の連続受信で 74.3 秒ぶんを取得、エラー出力なし。
**ただしクライアントは ffmpeg であって VRChat ではない。**
報告されている 60 秒切断は VRChat の RTSP キープアライブ送信の遅さに起因するため、この検証では否定できない。

## ブラウザ側の実測

| 検証 | 結果 |
|---|---|
| Chrome / Safari / Playwright 同梱 Chromium | **3 つとも契約 4 条件を充足** |
| Safari 26.5.2 | 全項目パス。ただし提示順の先頭が High、**帯域は Chrome の約 1.9 倍**（940 vs 500 kbps） |
| Firefox | **未実測**（本機で起動できず） |
| `getDisplayMedia` のジェスチャ要件 | **ユーザークリック必須**。読み込み直後の呼び出しは解決も棄却もしない |
| 画面全体の共有 | macOS の画面収録許可（TCC）未付与ではピッカーが解決しない。**自タブ共有は回避でき 300ms** |
| 送出解像度 | `getSettings()` は 1920x1080 を返すが**実送出は 1602x1032** |
| ウィンドウのフォーカス喪失 | **劣化しない**（1920x1080 を 24 秒維持、`qualityLimitationReason` 終始 `none`） |
| 同一ウィンドウの別タブ切替 | **未実測**（自動化の 3 経路すべて失敗） |
| MediaMTX 側の安全網 | **answer から Main / High を落とす**（High 先頭の offer でも Baseline へ矯正） |

profile が `42e01f`（Constrained Baseline）か `42001f`（Baseline）かの差は `setCodecPreferences` の並び順によるもので、**どちらも契約を満たす**。

### 品質設定の効果（300 kbps に絞った時）

**これが `contentHint` と `degradationPreference` を必須要件にした根拠。**

| 設定 | 挙動 | 12px 日本語 |
|---|---|---|
| `contentHint='text'` + `maintain-resolution` | **1080p を維持し、fps が 1 まで落ちる** | **読める** |
| 既定寄り（`motion` + `maintain-framerate`） | **640x360 まで解像度が落ちる** | **完全に判読不能** |

QP は後者の方が低い（19.6 vs 35）にもかかわらず読めない。
**「圧縮を緩める」ではなく「解像度を守る」が正しい操作**という結論を、ライブ経路でも裏づけた。

## Indigo 実機検証（2026-08-31 実測。Issue #91）

WebARENA Indigo の実インスタンス（6 vCPU / 8GB / 1Gbps・Ubuntu 24.04・グローバル IP を NIC 直付け = NAT なし）に
MediaMTX **v1.20.1** を本番既定ポートで立てて実測した。経路は自宅回線（フレッツ系）↔ Indigo。

| # | 検証項目 | 受け入れ基準 | 実測 | 判定 |
|---|---|---|---|---|
| I1 | **UDP 8189 インバウンド** | 外部から到達する | ポータル FW 開放後、実 WHIP の ICE が **UDP で成立**（`local: host/udp/161.34.34.128/8189, remote: prflx/udp/{自宅IP}`。tcpdump でも双方向の UDP を確認） | **合格** |
| I2 | A1: 実サーバー経由のコーデック契約 | h264 / Baseline / yuv420p / B フレームなし | `codec_name=h264` `profile=Baseline` `pix_fmt=yuv420p` `has_b_frames=0` `1920x1080`（Mac の Chrome → WHIP → Indigo → RTSP/TCP を ffprobe） | **合格** |
| I3 | 持続スループット（上り: 配信者→サーバー） | 数分の持続値を得る | **112 Mbps**（180 秒平均。30 秒区間で 82〜175 Mbps に変動） | 測定完了 |
| I4 | 持続スループット（下り: サーバー→視聴者） | 数分の持続値を得る | **192 Mbps**（単一 TCP・180 秒平均、区間変動ほぼなし）/ **349 Mbps**（並列 4 本・60 秒） | 測定完了 |

### 読み方の注意

- **I3 / I4 は min(自宅回線, 経路, Indigo) の下限値**。単一測定点からの実測であり、Indigo の出口単独の上限ではない。
  それでも「公称 1Gbps がベストエフォートでどこまで出るか」の持続の証拠として、
  下り 349 Mbps ≒ 標準画質（352 kbps）**約 990 視聴者ぶん**の同時送出が経路込みで通ることを確認できた
- ポータルのファイアウォールは**既定で全ポート遮断（SSH のみ許可）**。tcpdump で NIC 到達 0 パケットを確認してから
  ポータルでルールを追加した。**UDP のルールもポータル UI で作成でき、実際に通る**（公式仕様に記載がなかった点の実測回答）
- 検証環境は無認証の公開 relay のため、path を推測困難なランダム名（`live/s-{hex12}`）にして運用した。
  本実装では WHIP 側に認証（`publishUser`/`publishPass` か送信元制限)を入れること
- v1.20.1 の初回 publish 直後に HLS muxer が一度 `unable to extract DTS: SPS not received yet` でクラッシュし、
  10 秒後の再生成で自動回復した（起動直後のレース。継続的な失敗ではない）

### I6: VRChat PC 実機の受け入れテスト A2 / A5 / A6 / A8 合格（2026-08-31。Issue #94）

VRChat PC 実機（ProTV の Stream モード）+ Indigo 上の MediaMTX **v1.20.1** で実施。

| # | 確認 | 結果 |
|---|---|---|
| A2 | `rtspt://stream.web-screen.net:8554/live/{id}` で映像が出る | **合格** |
| A5 | 5 分以上再生を維持（60 秒切断の既知問題） | **合格**。サーバーログでも単一 RTSP セッションが 7 分以上継続、切断ゼロ |
| A6 | 途中参加（URL 貼り直し） | **合格**（体感 2 秒以内。キーフレーム 2 秒周期の設計値どおり） |
| A8 | 採用バージョン | **v1.20.1 で確定**（切断が再現しなかったため v1.15.5 への降格は不要） |

- 同一インスタンスの別プレイヤー（別グローバル IP）のクライアントが同じ path を直接読みに来ることもログで確認
  （視聴者ごとの直接ユニキャストという設計前提のとおり）
- A3はPCで実測済みだが、AACは音声付き1秒以下に未達、MP3は音声未実聴のため判定保留。A7は現行AACで合格済み。残る実機項目は、`Use Low Latency` の実値を確認できる条件での再測定と、MP3昇格条件A12である

### I7: 遅延の過去実測 — RTMP映像条件で約0.08秒（VRChat PC実機・2026-08-31。Issue #95 A3）

時計描画ページ（poc/whip-publisher.html）を VRChat と同一の Windows マシンで表示し、
両画面をスマホ動画で撮影してフレームごとの時計差を読んだ（同一時計源のため時計ずれなし）。
経路はWindows → Indigo → Windowsの実ネットワーク往復で、Quest対応前の同じYamaStreamにおける**RTMP映像条件**である。ワールドの `Use Low Latency` 実値はログから確認できていない。

| 配信設定 | VRChat の表示更新 | 遅延 |
|---|---|---|
| maxBitrate 600 kbps | **2.00 秒ごと（キーフレームのみ）** | 0.53〜2.53 秒のノコギリ波（最小 0.53 秒） |
| maxBitrate 2500 kbps | 毎フレーム | **0.08 秒（5 サンプル全て ±0.01 秒以内）** |

- 約0.08秒は**RTMP映像条件の過去値**である。現在のRTSPT動画のみ0.059秒やH.264/AAC 1.239秒との比較は、送出条件・音声条件を揃えていないためプロトコル差の結論には使わない
- **ビットレート不足は遅延にも化ける**: 600 kbps ではデルタフレームが実質空（I5）のため表示が
  キーフレーム周期でしか進まず、体感遅延が最大 2.5 秒まで揺れる。画質の段設計は帯域だけでなく
  体感遅延の問題でもある
- `Use Low Latency` の実値を確認できる条件での測定は未実施

### I8: Indigo 実機の reader あたり CPU は約 0.15%/reader — 律速は CPU ではなく帯域（2026-08-31）

586 kbps のストリーム 1 本を Indigo 実機（6 vCPU・Ubuntu 24.04・MediaMTX v1.20.1）に publish し、
Mac から `ffmpeg -c copy`（デコードなし）の読者を実ネットワーク越しに段階投入。
CPU は mediamtx プロセスの CPU 時間差分（60 秒窓）で測定した。

| readers | CPU（1 コア=100%） | RSS |
|---|---|---|
| 0 | 6.7 % | 74.8 MB |
| 20 | 11.7 % | 76.4 MB |
| 40 | 11.7 % | 78.8 MB |
| 60 | 16.7 % | 79.6 MB |
| 80 | 18.3 % | 82.3 MB |

- 傾き **約 0.15%/reader（1 コアあたり約 690 本）**。`ps -o time` の分解能（1 秒 = 60 秒窓で 1.7%）による
  量子化ノイズを含むため ±2 割は見るべきだが、**M3 Ultra ローカルの 0.7〜0.9%/reader（V7）より 5 倍前後軽い**
- 帰結: **Indigo 実機では CPU 律速にならない**（6 vCPU × 690 ≒ 4,000 reader 相当 ≫ 帯域上限）。
  収容人数は `min(帯域, 転送量)` で決まり、[capacity.md](capacity.md) の CPU 上限行は実機値で差し替える
- V7（macOS）との差は OS のソケット実装差と見られる。**ローカル macOS の CPU 実測を VPS の見積もりに使わない**

### I9: 実ページ素材のレートスイープ — 600k は破綻、膝は 1200k（2026-09-01。Issue #124）

これまでの段設計は **canvas に描いた文字ラダー**での実測だったため、実際の Web ページより素材が軽く、
**600 kbps を過大評価していた**。画像込みの実 Web ページを 240 px/秒で往復スクロールさせて測り直した。

測定: Mac の Chrome → WHIP → Indigo（MediaMTX v1.20.1）→ RTSP/TCP。受信側 ffmpeg の `freezedetect`
（0.4 秒以上の停止を検出）と、サーバー API の `inboundBytes` 差分で 20 秒窓を評価。

| 上限 | 受信 fps | フリーズ合計（20秒中） | 実効 |
|---|---|---|---|
| 600 kbps | 8.7 | **2.3 秒** | 533 kbps |
| 800 kbps | 14.3 | 0.7 秒 | 819 kbps |
| 1000 kbps | 20.6 | 0.5 秒 | 1,052 kbps |
| 1200 kbps | 24.9 | 0 | 1,273 kbps |
| 1500 kbps | 24.8 | 0 | 1,618 kbps |
| 2000 kbps | 25.9 | 0 | 2,118 kbps |

- **1200 kbps で fps が頭打ち・フリーズゼロ**になる（膝）。それ以上は帯域を食うだけ
- VRChat 実機（ProTV）で 1200 / 1500 / 2000 kbps を貼り替えて比較したが、**体感差なし**（2026-09-01）。
  1200k でもスクロール中の文字が読め、遅延も感じないレベル
- 同じ測定を合成素材（文字ラダー）で行うと 600k でも 23.5 fps・フリーズ 0 だった。
  **素材を実物に寄せないとレート設計を誤る**
- この結果から一度は画質段を廃し **1500 kbps 単一**としたが、同日の YouTube 再生でカクつきが出たため、
  一度 2000 kbps / 30 fps / motion 優先へ上書きした。現行値は後続の I16 と stability-audio-verification.md を参照

### I10: VRChat に貼る URL はハイフンで切り詰められる（2026-09-01）

`rtspt://stream.web-screen.net:8554/live/verify1200-9b5d21` を VRChat に貼ったところ映像が出ず、
サーバーログに **`live/verify1` への接続**が記録されていた（ハイフン以降が欠落）。
path をハイフンなしの短い名前に変えると即座に再生できた。

- **発行する path ID にハイフンを含めない**こと（[requirements.md](requirements.md) の 12 文字英小文字+数字の規則を厳守）
- UI のコピーボタン実装時（#128）に、貼り付け先で URL が欠けないことを実機で確認する
- 原因の特定までは至っていない（VRChat 側の入力処理か、コピー経路のどちらか）。**未確認**

### I11: VRChat はポート省略の RTSP URL を受ける（2026-09-01）

`rtspt://161.34.34.128/live/p554`（**ポート番号なし**）を VRChat PC 実機に貼って再生できた。
RTSP の既定ポート 554 が補われている。

- 検証構成: Indigo の 554/tcp をポータル FW で開け、`iptables -t nat -A PREROUTING -p tcp --dport 554 -j REDIRECT --to-port 8554`
  で 8554 の MediaMTX へ転送した（PoC 用の暫定。**本番は MediaMTX に 554 を直接リッスンさせる** → [requirements.md](requirements.md)）
- 事前確認: Mac から `ffprobe -rtsp_transport tcp rtsp://161.34.34.128/live/p554` が
  h264 / Constrained Baseline / yuv420p / `has_b_frames=0` を返した
- 結論: 配信 URL から `:8554` を落とせる。**ホスト名は #93 の凍結どおり変えない**ので、
  allowlist 登録済みワールドへの影響はない（VRChat の Allowed Domains はホスト名だけを見る）
- 効果: `rtspt://stream.web-screen.net/live/{id}` となり、TopazChat（`rtspt://topaz.chat/live/{key}`）と同程度の長さになる

### I12: Quest は PC と同一の rtspt URL で再生できる。HLS は不要（Quest 実機・2026-09-01）

Meta Quest 単体の VRChat で `rtspt://stream.web-screen.net/live/qtest`（本番形そのもの。ホスト名 + ポート省略 554）を
貼って再生できた。**PC と Quest で URL を分ける必要がなく、Quest 向け HLS 配信も不要**。

| 確認 | 結果 |
|---|---|
| 映像 | 再生 OK（RTSP over TCP。サーバーログに `with TCP, 2 tracks (H264, MPEG-4 Audio)`） |
| 音声 | **AAC が Quest で鳴る**（R3 の実機裏取り） |
| 体感遅延 | **2〜3秒**（同じYamaStreamでのRTSPT H.264/AACは中央値1.239秒。Quest/VRChat受信経路側に残る現状境界） |
| 安定性 | 80 秒前後のセッションを複数回、切断なし |
| `rtsp://`（8554 明示） | 再生 OK |

- **`rtmp://` は使えない**: Quest のプレイヤーは rtmp スキームの URL でも RTSP プロトコルで接続し、
  リクエスト URI のスキームを rtmp のまま送る。MediaMTX はスキーム検査で
  `invalid URL (rtmp://...)` として弾く（3 回再現）。TopazChat が「Quest は rtmp://」と案内して
  動くのは、同社サーバーがスキームを検査しないためと推測される。**WebScreen は rtmp を案内しない**
- 「2026-07 の VRChat アップデートで Quest の rtsp:// が動かなくなった」という TopazChat 開発者の報告
  （[X 2026-07-03](https://x.com/TyounanMOTI/status/2073100093818044578)）は、**本構成（MediaMTX v1.20.1 +
  rtspt/rtsp・TCP）では再現しなかった**
- HLS（`https://stream.web-screen.net/live/{id}/index.m3u8`・Caddy TLS 終端）はサーバー側の生成・配信まで
  確認済みだが、Quest 実機での再生は rtspt が通ったため**未検証のまま打ち切り**（必要になったら再開する）

### I13: 新ドメイン webscreen.tv で PC / Quest とも再生できる（実機・2026-09-01）

配信ホストを専用ドメイン `webscreen.tv`（apex・A レコードで Indigo 直指し・Cloudflare プロキシ OFF）へ
切り替え、`rtspt://webscreen.tv/live/qtest` を **PC / Quest の両実機で再生確認**した。
体感遅延はPC < Quest（同じYamaStreamでのRTSPT H.264/AACは中央値1.239秒、Questは2〜3秒。network受信後のdecode / render / bufferの具体的要因と値は未確認）。約0.08秒は同じワールドでQuest対応前に測ったRTMP映像条件の過去値であり、RTSPTや `Use Low Latency` の効果を示すものではない。

- 移行理由: Quest では URL を手打ちするしかなく、ホストが 21 文字 → 12 文字・ハイフン 2 個 → 0 個になる
- DNS のみで完結（RTSP はホスト名を見ないため、サーバー側の設定変更は不要だった）
- 旧 `stream.web-screen.net` の A レコードは検証用に残すが、案内はすべて webscreen.tv に統一（requirements.md の凍結を更新済み）

### I5: 動画素材の画面共有は 600 kbps では成立しない（VRChat 実機・2026-08-31）

VRChat PC 実機（ProTV）で `getDisplayMedia` の実画面（YouTube 再生中のタブ・1916x1060）を配信して観測した。

| maxBitrate | サーバー受信の実測 | VRChat での見え方 |
|---|---|---|
| 600 kbps | 約 10 fps 届くが、実効はキーフレーム（2 秒周期）のみ更新 | **約 3 秒に 1 枚のコマ送り** |
| 2500 kbps | **実効 1,541 kbps・約 26 fps** | **滑らか** |

- 原因: 2 秒ごとの強制キーフレーム（V3）が 600 kbps の予算を食い尽くし、
  デルタフレームが実質「変化なし」になる。**quality-tiers の実効 352 kbps は静止テキスト前提の値**で、
  フルモーション素材には適用できない
- 影響: 動画を含む画面共有を許すなら、**1 視聴者あたりの帯域・転送量が静止ページの 4〜7 倍**になり、
  収容人数と転送量の計算（[capacity.md](capacity.md) / [quality-tiers.md](quality-tiers.md)）が素材依存で変わる。
  製品設計で「静止ページ向け（600k）/ 動画向け（2.5M）」の段を分けるか、動画素材を制限するかの判断が要る

### I14: 本番一気通貫の E2E — API 発行 JWT で WHIP publish → rtspt 視聴（2026-09-01）

本番構成（#126 の MediaMTX + Caddy + Worker secrets + PR #142 の配信 API）で、製品と同じ経路の配信開始〜視聴を実証した。

- 経路: 本番ページのオリジンから `POST /api/streams/`（Discord ログイン済み）→ 返された publishToken で `https://webscreen.tv/live/{id}/whip` へ WHIP publish（映像源は canvas.captureStream。画面ピッカーだけ代替、コーデック選定・認証・接続は製品と同一）→ WHIP 201・Location は相対パス・PeerConnection connected
- 視聴: `rtspt://webscreen.tv/live/{id}` を ffprobe で受信し、**h264 / Baseline / yuv420p / B フレーム 0**（encode-contract の 4 条件）を確認。実フレームのデコードも確認
- 停止: `POST /api/streams/{id}/stop/` が 204 → MediaMTX から path が消え、再アクセスは 404
- lifecycle: heartbeat 失効の合成セッションが毎分 cron により `ended / heartbeat_lost` になることも同日確認（cron トリガーは `wrangler triggers deploy` の再実行が必要だった。運用注意は [operations.md](operations.md)）
- 未検証のまま残る点: 実ブラウザの getDisplayMedia からの一気通貫（画面ピッカーはネイティブ UI のため自動化不可。ユーザーの実操作で確認する）と、バックグラウンドタブでの heartbeat 維持（10 分放置）

### I15: 2 Mbps・音声付き split relay の本番実測（2026-09-01）

PR #151 の本番反映後、実 Google Chrome 152.0.7977.65 から 1920x1080 canvas と 48 kHz stereo のテスト音を
45 秒間 publish し、ingress → ffmpeg relay → egress を確認した。

| 確認 | 結果 |
|---|---|
| ブラウザ送出 | H.264 Baseline / **1920x1080 / 30 fps**。45 秒時点で 1,254 frames encoded |
| ingress | H.264 + Opus、20.067 秒窓で **1.891 Mbps** |
| egress | H.264 + MPEG-4 Audio、20.067 秒窓で **1.984 Mbps** |
| ffprobe | H.264 Baseline / yuv420p / B フレーム 0 / 1920x1080 / 30 fps、AAC-LC / 48 kHz / stereo |
| codec gate | `verify-codecs.sh` が H.264 + AAC を検出して合格 |

ログイン済みブラウザを安全に自動操作できなかったため、テスト中だけランダムな1 path を JWT publish 除外へ追加した。
測定後は除外を `read` / `api` のみに復元し、永続設定ファイルのchecksum不変、ingress / egress両方のpath消滅を確認した。
この検証は media経路と設定値を対象とし、Workerのセッション発行とhealth gateは I14・自動テスト・deploy preflightで別に担保する。

### I16: 30 / 24 fps・1.1〜1.3 Mbps の本番比較（旧劣化方針・2026-09-01）

実 Google Chrome 152.0.7977.65 で、Wikipedia 富士山ページの実スクリーンショットを 240 px/秒で往復スクロールし、
440 Hz 音声とともに本番 relay へ送った。これは actual YouTube ではなく、`motion` / `maintain-framerate` の候補間を同条件で比べる代表素材である。

| fps / 映像上限 | browser fps | RTSP fps | freeze | ingress | total egress | 判定 |
|---|---:|---:|---:|---:|---:|---|
| 30 / 1.1 Mbps | 30.02 | 27.75 | 0 | 1.183 Mbps | 1.279 Mbps | 最低合格 |
| **30 / 1.2 Mbps** | **30.01** | **29.96** | **0** | **1.291 Mbps** | **1.385 Mbps** | **既存比較の候補。1.5 Mbps から 115 kbps の余裕** |
| 30 / 1.3 Mbps | 30.01 | 27.67 | 0 | 1.396 Mbps | 1.501 Mbps | 上限超過 |
| 24 / 1.1 Mbps | 24.01 | 22.49 | 0 | 1.168 Mbps | 1.260 Mbps | 不採用 |
| 24 / 1.2 Mbps | 24.00 | 22.12 | 0 | 1.292 Mbps | 1.389 Mbps | 不採用 |
| 24 / 1.3 Mbps | 24.02 | 22.97 | 0 | 1.401 Mbps | 1.491 Mbps | 23 fps 未満かつ余裕不足 |

- 全候補で H.264 Baseline / yuv420p / B フレーム 0、AAC-LC / 48 kHz / stereo を確認
- 5秒音声は mean 約 -27.5 dB、max 約 -24 dB、RMS 約 -27.45 dB で非無音
- 入力 canvas は 1280x720。Chrome の `maintain-framerate` 帯域適応により実送出・RTSP は 960x540
- 一時的な publish 認証除外は復元済み。永続設定 checksum 不変、テスト path 404、remote 一時ファイル削除を確認

30 fps / 1.2 Mbps は出口 fps が入力に追従し、freeze 0 のまま total egress を 1.5 Mbps 未満に収めた。
24 fps は帯域をほぼ減らさず出口が全候補で 23 fps 未満のため、余裕を増やす手段として採用しない。

### I17: actual YouTube は音声・接続継続を確認、動画像の長時間定量測定は保留（2026-09-01）

actual YouTube を音声共有ありで本番 relay と VRChat PC 実機へ配信した。これは I16 の代表素材比較とは別の実機観測である。

| 確認 | 結果 |
|---|---|
| ユーザー実機 | **音声付きで安定**。開始直後は少しカクついたが、約30秒で自然に安定 |
| 本番の接続継続 | 配信 path が計 **14分25秒以上 active**。途中切断なし |
| RTSP codec | H.264 Constrained Baseline / yuv420p / B フレーム 0、AAC-LC / 48 kHz / stereo |
| 音声 | mean **-19.9 dB**、max **-7.6 dB**。非無音 |

10分06秒の全体集計は ingress 0.582 Mbps、total egress 0.611 Mbps、12.16 fps、480x270、freeze 25回 / 333.657秒だった。
しかし Big Buck Bunny が測定中に終了し、後半の静止画が混入した。動画終了時刻別の帯域・fps・freeze 時系列を保存していないため、
動画像区間だけの値は復元不能である。よって、この全体集計を **1.0〜1.5 Mbps 条件の合否や映像安定性の判定に使わない**。

文字が不可読だった観測では 274x148、1.78 fps、total egress 0.064 Mbps だった。動画像終了後の静止画では低い実効ビットレートは正常なため、
この低実効値だけを合否に使わない。

証明済みなのは、本番で AAC 音声が聞こえること、14分超の接続継続、開始後約30秒でユーザー体感が安定すること。
`detail` / `maintain-resolution` / scale 1 の候補で actual YouTube の動画像をループさせた長時間の fps・freeze・帯域と文字可読性は未証明であり、再測定が必要である。開始直後のカクつきは自然回復したため、
一律の「カクついたら再起動」は案内せず、relay 未到達時だけ再接続する方針を維持する。

### I18: 採用設定の本番 relay 合成QAは合格（2026-09-01）

1280x720 / 30 fps / maxBitrate 1.2 Mbps / `detail` / `maintain-resolution` / scale 1 / H.264優先 / 48 kHz stereo で、本番 relay を測定した。

| phase | RTSP | freeze | video | total egress |
|---|---|---:|---:|---:|
| A motion（120秒） | 1280x720 / 30.00 fps | 0 | 0.899 Mbps | 1.037 Mbps |
| B static（60秒） | 1280x720 / 30.00 fps | 59.999秒（意図した静止） | 0.264 Mbps | 0.397 Mbps |
| C motion（120秒） | 1280x720 / 30.06 fps | 0 | 0.896 Mbps | 1.035 Mbps |

- H.264 Baseline / yuv420p / B フレーム 0、AAC-LC / 48 kHz / stereo、音声 mean -25.0 dB の非無音を確認
- 16 / 24 px文字は明瞭、12 pxも判読可能。Cでは解像度・fpsが回復
- rawのA freeze 1.000秒とB 58.999秒は、RTSP接続がsource phaseより約1秒遅れた境界差。source phase補正後のA/Cはfreeze 0
- 1.25 Mbpsは不要と判断し未試験。cleanupではchecksum不変、認証除外の復元、両pathの404、remote一時ファイル0を確認

本番WebScreen UIからactual YouTubeを再確認する最終確認は未実施。I17のactual YouTube観測とこのI18のrelay合格を混同しない。

### I19: 約3秒に見えた RTSPT 遅延を配信経路と受信側に分離（2026-09-01）

RTMP と RTSPT が異なる遅延に見えた観測を、同一 H.264 packet と送信元時計で分けて再測定した。
結論は、**配信元のオンライン時計から本番 RTSPT 出口までは 1 秒未満**であり、MediaMTX + FFmpeg relay は約 70 ms である。

| 測定 | 方法 | 結果 |
|---|---|---|
| ingress → egress | 同一 H.264 packet payload hash を照合（335 packets） | median **69.6 ms** / p95 **132.8 ms** / max **183.9 ms** |
| 配信元時計 → RTSPT 出口 | 入力にオンライン時計を描画し、出口で `-use_wallclock_as_timestamps 1` + `-copyts` + `-frame_pts 1` を用いて 9 フレームを OCR | **0.097〜0.294 秒**、中央値約 **0.11 秒** |
| WebRTC 入力の損失（単一時点） | MediaMTX 統計とログを確認 | 197,851 received / 79 lost（約 **0.04%**）、discarded frame 1、write queue full なし |

初期の `strftime` / fps 採取は約 3 秒に見えたが、採取側のバッファを含んでいたため結論に使わない。長時間観測は **24分47秒**で stream 終了まで確認した時点で、28〜29 fps、egress 1.2〜1.3 Mbps だった。30 分の安定性合格は未達である。

relay 設定の A/B では、通常設定から実質的な改善はなかった。

| relay 設定 | median | p95 | max | 判定 |
|---|---:|---:|---:|---|
| baseline | 65.0 ms | 122.6 ms | 178.2 ms | 基準 |
| `nobuffer` + `low_delay` + `flush` | 61.1 ms | 124.7 ms | — | 実質改善なし |
| 上記 + `max_delay=0` | 61.6 ms | 126.7 ms | — | 実質改善なし |

`-probesize 32 -analyzeduration 0` は H.264 dimensions unspecified / Could not write header で起動不能となり不採用。FFmpeg の低遅延入力オプションは [formats documentation](https://ffmpeg.org/ffmpeg-formats.html) を参照。MediaMTX は reader へ即時送出し、遅延用バッファを持たないという maintainer の説明とも整合する（[discussion #3660](https://github.com/bluenviron/mediamtx/discussions/3660)）。したがって、**本番 relay 設定は変更しない**。約 70 ms の relay を危険な起動不能設定で削っても 3 秒の説明にならず、RTMP を復活させる理由にもならない。

判断境界は Quest/VRChat 受信経路側に残る。

- **PC VRChat（YamaStream）**: 同じワールドで、RTSPTの動画のみは0.026〜0.080秒（6標本の中央値0.059秒）、H.264/AACは文字・音声とも明瞭だが17標本・独立12標本とも中央値1.239秒で音声付き1秒以下未合格だった。独立12標本は1.157〜1.321秒、平均1.237秒で、17標本の1.203〜1.282秒と再現した。Quest対応前のRTMP映像条件で測った約0.08秒は過去値としてだけ残し、RTMP対RTSPTのプロトコル差を示す比較には使わない。NTP時計の大時計自体が補正済みなので、下段の端末ずれを重ねて引かない。ログから `Use Low Latency` の実値は直接確認できない。Public で egress reader が0本なら、RTSP前のAllowed Domains拒否を確認する。Windows 向けの同プロパティは [AVPro documentation](https://www.renderheads.com/content/docs/AVProVideo/articles/inline-component-media-player-properties-windows.html) を参照。
- **Quest の 2〜3 秒**: 同じ `rtspt://webscreen.tv/live/{id}` で再生できるが、これは Quest/VRChat 受信経路側に残る現状境界である。ネットワーク受信後の decode / render / buffer の具体的要因と値は未確認。Media3 の標準 `DefaultLoadControl` の既定バッファは説明可能性の参考にすぎず、VRChat の具体的な設定値を示さない（[Android reference](https://developer.android.com/reference/androidx/media3/exoplayer/DefaultLoadControl)）。サーバー設定だけで Quest の 1 秒未満を保証することはできない。

未確認のまま残すものは、YamaStream の `Use Low Latency` 実値、RTMP対RTSPTのPCプレイヤーまでのプロトコル差、MP3音声のPC実聴、およびQuestでのMP3映像・音声・1秒未満である。MP3 relayのcapacity・30分安定性はI21、実Mac動的映像の30 / 24 fps比較はI22で解消した。

### I20: YamaStream の PC 実機 — Public の許可設定と精密遅延（2026-09-02）

同じYamaStreamで `rtspt://webscreen.tv/live/{id}` のH.264/AACを AVProVideoPlayer に再生した。画面文字はクリアで、ユーザー実画面の体感は約1秒だった。初回のWindowsデスクトップ30 fps同時録画17標本は1.203〜1.282秒、中央値1.239秒だった。実Mac配信の独立再測定12標本は1.157〜1.321秒、中央値1.239秒、平均1.237秒で、音声付き1秒以下の未達を再現した。同じRTSPT映像からAAC音声を除いたA/Bは0.026〜0.080秒、6標本の中央値0.059秒だった。Quest対応前に同じYamaStreamで測った約0.08秒はRTMP映像条件の過去値であり、RTMP対RTSPTのプロトコル差は未切り分けである。時計ページ下段の「端末が遅れ／進み」は補正量の表示であり、大時計はすでに補正済みなので時計差から重ねて引かない。I19の配信元時計から本番RTSPT出口までの中央値約0.11秒とは測定境界が異なり、PCプレイヤーまで含む実測として記録する。

| 段階 | 観測 | 結論 |
|---|---|---|
| Public | VRChat ログは `webscreen.tv` が Video Player Allowed Domains に無いとして AccessDenied。VRChat Public API の当該ワールド `urlList` は空、MediaMTX egress readers は 0 | URL は RTSP 接続前に拒否された。relay / codec / 遅延の問題ではない |
| Friends+ | hidden instance へ移動し `Allow Untrusted URLs` を有効化 | 再生開始 |
| AVPro 再生 | `MediaFoundation` で open、`MF-MediaEngine-Hardware` で 1280x708 / 30.00 fps。egress reader 1 本が継続し bytesSent が増加 | PC の Media Foundation 経路で映像・音声を継続再生 |
| AAC音声付き | Windowsデスクトップ同時録画（30 fps、分解能約0.033秒）の17標本と、実Mac配信の独立12標本をNTP補正済み時計で採取 | 17標本 **1.203〜1.282秒**、独立12標本 **1.157〜1.321秒**、両者の中央値 **1.239秒**（後者の平均 **1.237秒**）。音声付き1秒以下未合格を再現 |
| 動画のみA/B | 同じH.264映像からAAC音声だけ除き、同じAVPro・ワールドで6標本を採取 | **0.026〜0.080秒**、中央値 **0.059秒**。1秒以下合格。約1.18秒の差は音声を含む受信条件で生じる |
| Opus直通A/B | 一時pathはH.264 + Opusの2トラック。AVPro接続中の6標本は **0.219〜0.356秒**、中央値 **0.255秒** | MediaMTXログでAVPro readerが選択したのはH.264の1トラックだけ。Opus音声は受信しておらず、音声付き合格には使えない |
| G.711 A/B | 一時pathはH.264 + G.711 | AVPro readerはH.264だけを選択し、音声なし。音声付き合格には使えない |
| MP3 A/B | 実Mac動的H.264 + MP3 48 kHz stereo 128 kbpsを同じYamaStream / AVPro 3.3.6 Media Foundationで再生し、30 fps同時録画16標本を採取 | AVPro readerはH.264 + MPEG-1/2 Audioの2トラックを選択。**0.129〜0.416秒、中央値0.151秒、平均0.175秒で全件1秒未満**。映像と低遅延は確認したがMP3音声の実聴は未確認 |
| RTMP A/B | egressを一時有効化し、Mac / WindowsのffprobeでH.264 + AACを取得。VRChat 2026.3.1で同じURLを開く | URL解決後、AVPro Media FoundationのOpeningからLoading failed。AVPro v3のWindows RTMPはDirectShow + LAV経路のため現行YamaStreamでは比較不能。検証後 `rtmp: false` に戻し1935 listenerなし |

YamaStreamの `Use Low Latency` 実値はログから直接確認できない。AACは独立2回とも中央値1.239秒で未合格、MP3候補は映像表示までのPC遅延のみ暫定合格した。MP3の30分・capacity・codec gateはI21、実Mac 24/30 fps比較はI22で合格したが、PC/Quest別の実聴とQuest 1秒未満が未確認なのでproduction設定はAACのまま変更しない。

### I21: MP3 betaの長時間・capacity・途中参加（2026-09-02）

- 20 relayはgate 20/20、relay CPU合計88.826%（1コア比）、host 26.49%（headroom 73.51%）。1 relay + 20 readersは全接続し、relay 6.974%、egress 11.031%、host 8.203%、約1.434 Mbps/viewer。
- 30分continuous sourceは53,975 frames、freeze/error/restart 0、memory約1.7%増。H.264 + MP3 48 kHz stereo 128 kbpsは非無音で、A/V nearest PTSは7〜15 ms。最初のlooping MKVはnon-monotonic DTSで無効、991 msはfirst-to-first計算の誤りとして破棄した。
- real Chrome + MediaMTXの20 reconnectはfirst packet K 3/20、non-K 17/20、次keyframe 0〜463 ms。decoderは初期missing-reference警告後に継続した。MediaMTXにGOP cacheがないため初回IDRは保証しない（従来本番は2〜3秒）。
- Chromeの単純な720p30 / 1.2 Mbps上限では、通常8秒が237 kbps / key 1、500 ms要求が456 kbps / key 16、quality limitationなし。24/30 fpsのsequential合成値は24設定が20.5 fps / 342.834 kbps / key 15、30設定が29.875 fps / 422.682 kbps / key 16。24設定はheadlessでunder-deliveryしたため実Mac比較には使わない。
- exact one `stream-profile=mp3-beta` のChromeだけ500 ms要求を有効化する。unknown/duplicate/通常アクセスは無効で、任意interval不可。非対応UAでは第2引数が無視されno-op loopになる可能性がある。
- 手動では初動カクつき後約30秒で安定、音声可、PCモード + Mac配信は安定し、今回は「めっちゃ速い」と観測された。ただしA12のPC/Quest別MP3実聴と1秒未満は未完。再起動を常設回避策にしない。
- rollback rehearsalはlocal Mac arm64 / MediaMTX v1.15.5の隔離高番ポートで実施。同じ1280x720 / 30 fps H.264 + AAC入力を維持し、candidateのH.264 + MP3 48 kHz stereoをcodec gateで確認後、SIGINT停止とpath停止を確認した。pre-PR main `e2369d0` の旧relayへ戻すとH.264 + AAC 48 kHz stereoが復旧し、`ffmpeg -xerror` の10秒decodeも合格した。終了後は4ポート閉鎖・残留processなし。本番Indigo / Workerと製品configは未変更で、検証configだけv1.15.5互換のためIPv6 CIDRを引用し未対応MoQキーを外した。
- 本番Indigoはread-onlyで確認し、`/opt/webscreen/streaming/relay.sh` のSHA-256がpre-PR main `e2369d0` と一致した。ingress / egressはactive、candidate用`audio-profile.sh`は未配置でlegacy AACを維持し、RTSP 554もlisten中だった。秘密値は取得・出力していない。

### I22: 実Macの30 / 24 fps比較（2026-09-02）

Chrome 152.0.7977.65 / macOS arm64で別タブを共有し、製品moduleから設定値を直接読み込んだ。入力は1280x720 ideal（タブ比率により実測1280x642）、H.264、映像上限1.2 Mbps、`detail`、`maintain-resolution`、scale 1、500 msキーフレーム要求で、30 / 24 fpsを各600秒測定した。

| 要求 | capture delivery | H.264 encode | 平均bitrate | 平均QP | keyframe要求 | quality limitation |
|---|---:|---:|---:|---:|---:|---|
| 30 fps | 16,824 frames / **28.040 fps** | 17,912 frames / **29.853 fps** | 約564.6 kbps | 20.76 | 1,193 / 1,193成功 | none |
| 24 fps | 14,335 frames / **23.892 fps** | 14,322 frames / **23.870 fps** | 約323.3 kbps | 21.41 | 1,192 / 1,192成功 | none |

両候補ともエラーなく安定した。30 fpsは送出29.853 fpsで滑らかさを維持し、平均QPもわずかに良く、1.2 Mbpsを十分下回ったため採用を維持する。24 fpsは計測済み代替候補として残すが推奨しない。60秒の順序反転比較でも24→30は23.799 / 29.565 fps、30→24は29.750 / 23.682 fpsで、quality limitationは全てnoneだったため順序依存は認めなかった。この完了はA12のfps小項目だけであり、PC/Quest別のMP3実聴と各1秒未満は未完である。

## 検証できていないこと

| # | 項目 | 影響 |
|---|---|---|
| 1 | ~~VRChat 実機での再生~~ | **2026-08-31 解消**（I6。A2/A5/A6 合格） |
| 2 | ~~VRChat クライアントでの 60 秒切断の有無~~ | **2026-08-31 解消**（I6。v1.20.1 で 7 分以上切断なし） |
| 3 | ~~実ネットワーク越しの帯域・遅延~~ | **2026-08-31 解消**（I3 / I4。ただし単一測定点の下限値） |
| 4 | VPS 実機での reader あたり CPU | M3 Ultra の 125 本/コアは楽観的な上限。多読者テスト時に Indigo で測り直す |
| 5 | 同一ウィンドウ内での別タブ切替時の挙動 | フォーカス喪失では劣化しないことは実測済み |
| 6 | Firefox の対応可否 | 本機で起動できず。切る判断が出せない |
| 7 | `getDisplayMedia` の解像度決定則 | 1920x1080 要求に対し実送出 1602x1032 になる理由 |
| 8 | ~~WHIP の UDP を NAT 越しに到達させる実構成~~ | **2026-08-31 解消**（I1。Indigo は NAT なしのグローバル IP 直付けで、`webrtcAdditionalHosts` 不要） |
| 9 | 本番WebScreen UIからactual YouTubeをループさせる長時間確認 | I18の合成relay QAとは別に、UI経路のfps・freeze・帯域・文字可読性を最終確認する |
| 10 | Safariでのfull設定の受理・実送出 | full設定拒否時はmaxBitrate-only fallbackで配信を継続するが、文字品質は別途確認する |
| 11 | YamaStream の `Use Low Latency` 実値とRTMP対RTSPTの差 | RTMPはMedia FoundationでLoading failedとなり現行ワールドではA/B不能。設定値もログから直接確認できない |
| 12 | Quest でMP3音声付き1秒未満 | PC/Quest別の統制済み実聴は未完。現行AACは体感2〜3秒で、サーバー設定だけでは保証不能 |
| 13 | ~~30 分の長時間安定性~~ | **2026-09-02解消**（I21。continuous sourceで30分、freeze/error/restart 0） |
| 14 | ~~実Mac動的映像の30 / 24 fps安定性比較~~ | **2026-09-02解消**（I22。各600秒、30 fps送出29.853 fps / 24 fps送出23.870 fps。30 fpsを採用） |
