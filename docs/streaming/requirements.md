# 実装の必須要件と設定値

**実装するときはこのファイルを正本にする。** 数値の根拠は [verification.md](verification.md)、なぜこの構成かは [architecture.md](architecture.md)。

## 守らないと壊れるもの

| # | 要件 | 理由 |
|---|---|---|
| **R1** | ブラウザ側で `setCodecPreferences` により **H.264 を最優先に固定する** | 既定の受入順は `VP8, rtx, H264…` で **VP8 が選ばれる**。VP8 で publish しても MediaMTX はエラーを返さず素通しし、**VRChat 側で「再生できない」という静かな失敗**になる |
| **R2** | H.264 が使えない環境を**検出して配信を開始しない** | `RTCRtpSender.getCapabilities('video')` に H264 が無ければエラーにする。黙って VP8 で始めない |
| **R3** | ブラウザ音声を **relay で AAC-LC 48 kHz / stereo / 128 kbps へ変換する**（Opus のままにしない） | AVPro 公式が「Media Foundation では Opus は読み込み失敗」と明記。映像は `-c:v copy` のままにし、音声がない配信も許可する |
| **R4** | `overridePublisher: no` を設定する | 既定 `true` は**後発の publisher が先発を蹴る**。他人の配信を奪える |
| **R5** | publish は path 単位の認証で保護する | JWT の `mediamtx_permissions` で `{action: publish, path: live/{id}}` を払い出す |
| **R6** | 本番は ingress / egress を分け、**映像 copy + 音声 AAC 変換だけを relay する** | WebRTC publisher と公開 RTSP reader の責務・認証・障害を分離する。HLS / RTMP / SRT / MoQ は無効にする |
| **R7** | HTTPS で提供する | Quest は HTTPS 必須。`getDisplayMedia` も secure context 必須 |
| **R8** | **WHIP の UDP ポート（既定 8189/udp）を配信者から直接到達させる** | **Cloudflare の裏に隠せない**。配信ドメインとは別に、オリジンへ直接届く経路が要る |
| **R9** | 最初の画面取得は**必ずユーザーのクリック起点**にする | `getDisplayMedia` はユーザージェスチャ必須。ただし取得済み MediaStream を使う WHIP の再 publish は自動で 1 回行ってよい |
| **R10** | 対応ブラウザで `contentHint = 'detail'`、`degradationPreference = 'maintain-resolution'`、`scaleResolutionDownBy = 1` のfull設定を試し、拒否時のみfresh parametersでmaxBitrate-only fallbackを1回だけ試す | I18の本番 relay 合成QAで文字可読性と動画安定性が合格。fallbackは配信継続の互換策であり、文字品質を保証しない |
| **R11** | 送出解像度は `getSettings()` ではなく **`outbound-rtp` の `frameWidth/frameHeight`** で確認する | 過去は 1920x1080 要求に対し実送出 1602x1032、旧 `maintain-framerate` の 1280x720 入力では 960x540 になった |
| **R12** | URL を表示する前に ingress / egress の受信 bytes 増加を確認する | WHIP の 201 だけでは VRChat 出口まで映像が届いたことを保証しない。未到達なら同じ画面で 1 回自動再接続し、それでも失敗した時だけ再接続ボタンを出す |

## 配信ホスト名と path 規則（2026-09-01 凍結。以後変更しない）

VRChat の **Video Player Allowed Domains** はワールド作者が上限 10 枠・ワイルドカード非対応で登録するため、
**ここを後から変えると登録済みワールドすべてで再生できなくなり、こちらからは直せない**（[vrchat-constraints.md](vrchat-constraints.md)）。
Issue #93 で `stream.web-screen.net` に凍結後、実装着手前の 2026-09-01 に **`webscreen.tv`**（専用ドメイン・apex 直付け）へ
上書きして再凍結した。理由: Quest では URL を手打ちするしかなく、9 文字短くハイフンが消えることの利便が大きい。
ドメインの**失効は allowlist 焼き込み後は致命傷**なので、レジストラの自動更新を切らないこと。

| 経路 | URL 形式 |
|---|---|
| **PC / Quest 共通（RTSP）** | `rtspt://webscreen.tv/live/{id}`（**ポート省略**。PC = I11、Quest = I12 で実機確認） |
| Quest（HLS・**保留**） | `https://cdn.web-screen.net/live/{id}/index.m3u8`（Quest が rtspt を直接再生できたため実装しない。rtspt が使えなくなった時のフォールバック設計として残す） |

- `{id}` は**推測困難な 12 文字のランダム ID**（既存の動画 shortId と同じ文字種・長さ）。
  **ハイフンを含めない**（VRChat 側でハイフン以降が切り詰められる = I10）
- RTSP は**既定ポート 554 でリッスンする**（`rtspAddress: :554`）。VRChat がポート省略の URL を受けるため、
  URL から `:8554` を落とせる（I11）。1024 未満のバインドには root か `CAP_NET_BIND_SERVICE` が要るので、
  systemd ユニットに `AmbientCapabilities=CAP_NET_BIND_SERVICE` を入れる（#126）
- **Quest も PC と同一の rtspt URL を案内する**（I12）。音声も AAC で鳴る。体感遅延は 2〜3 秒（PC の 0.08 秒より大きいが十分低遅延）。
  **`rtmp://` は案内しない**: Quest のプレイヤーは rtmp スキームでも RTSP を話すため、スキームを検査する MediaMTX が弾く（I12）
- Quest 向け HLS を実装する場合は新ホストを作らず **既存の `cdn.web-screen.net` に相乗り**する（HLS セグメントを R2 経由で配る設計と一致し、
  ワールド作者の allowlist 消費が新規 1 枠 = `webscreen.tv` だけで済む）
- 旧凍結名 `stream.web-screen.net` の DNS A レコードは検証用に残っているが、**案内には使わない**（実装・文言はすべて webscreen.tv）
- **サブドメインを今後増やさない**（ワイルドカード非対応のため、増やすたびに全ワールドの再登録が要る）
- 複数台へスケールする時は L4 ロードバランサか DNS の複数 A レコードで**同一ホスト名のまま**振り分ける
  （[server-plan.md](server-plan.md) Phase 3）。ホスト名は凍結だが、**A レコードの向き先（IP）は自由に変えてよい**

## MediaMTX と relay の設定

動作確認済みの雛形は [poc/mediamtx-poc.yml](poc/mediamtx-poc.yml)（検証用にポートをずらしてある。本番は既定ポートでよい）。

| 設定 | 値 | 補足 |
|---|---|---|
| バージョン | **v1.20.1（2026-08-31 に VRChat 実機で確定。Issue #94 / A8）** | PC 実機で A2（映る）/ A5（5 分以上・60 秒切断なし）/ A6（途中参加 2 秒以内）を通過。60 秒切断問題は再現しなかった |
| ingress RTSP | `127.0.0.1:8554` / TCP のみ | relay の入力専用。外部公開しない |
| egress RTSP | `:554` / TCP のみ | VRChat の `rtspt://` 出口。匿名 read のみ公開する |
| ingress WebRTC | HTTP `127.0.0.1:8889`、ICE `:8189/udp` | Caddy は WHIP HTTP を中継し、ICE はオリジンへ直接到達させる |
| Control API | ingress `127.0.0.1:9997` / egress `127.0.0.1:9998` | Caddy で別 bearer token を要求し、Worker も別 token を持つ |
| relay | H.264 `copy`、音声は任意で AAC-LC 48 kHz / stereo / 128 kbps | path ID を検証し、通常失敗は最大 3 回だけ再試行。停止シグナル時は再試行しない |
| 不使用プロトコル | RTMP / HLS / SRT / MoQ を無効化 | 公開面と不要な listener を増やさない |
| `overridePublisher` | `no` | R4 |
| `webrtcTrackGatherTimeout` | **15 秒程度へ延ばす**（既定 2 秒は短い） | 既定のままだと publish 開始に失敗することがある |
| キーフレーム間隔 | **2.00 秒固定・変更不可** | MediaMTX が WebRTC publisher へ 2 秒周期で PLI を送る。Go の `const` のため設定で変えられない |

### キーフレーム 2 秒固定が連鎖させる制約

これは設定で回避できないため、仕様として受け入れるか、MediaMTX をフォークするかの二択になる。

- **VRChat で URL を貼ってから映像が出るまで最大 2 秒**（実測 1.7〜2.0 秒）
- **HLS のセグメント長もキーフレームで切られるため 2 秒が下限**。`hlsSegmentDuration: 1s` と書いても `EXT-X-TARGETDURATION` は 2 になり、**Quest の遅延は約 6 秒**になる
- 「キーフレーム間隔 1 秒」を要求する配信先（VRCDN 等）は既定では満たせない

## ブラウザ側の設定

動作確認済みの雛形は [poc/whip-publisher.html](poc/whip-publisher.html)。

| 設定 | 値 | 補足 |
|---|---|---|
| コーデック | `setCodecPreferences` で H.264 を先頭へ | R1 |
| ビットレート上限 | **`encodings[0].maxBitrate = 1_200_000`（単一。モード選択 UI は作らない）** | I18では動画像のtotal egress約1.04 Mbpsで30 fps・freeze 0。WebScreen UIからactual YouTubeを最終確認する |
| 劣化ポリシー | `degradationPreference = 'maintain-resolution'` | R10。I18で動画像・文字可読性とも合格 |
| コンテンツヒント | `track.contentHint = 'detail'` | R10。I18で動画像・文字可読性とも合格 |
| スケール | `encodings[0].scaleResolutionDownBy = 1` | R10。I18で動画像・文字可読性とも合格 |
| 解像度 / fps | **入力 1280x720 / 最大 30 fps** | I18で動画像のRTSP出力は1280x720 / 30.00〜30.06 fps。24 fpsの旧代表素材比較は変更しない |
| 画面取得 | `getDisplayMedia({ video, audio: true })`（**既定ピッカー**。画面全体・ウィンドウ・タブから選ばせる） | Chrome のタブ共有で「タブの音声を共有」をオンにした時だけ音声が付く。macOS の画面収録未許可はエラー文言でシステム設定へ案内する |
| 開始判定 | ingress / egress bytes を最大 10 秒、1 秒間隔で監視 | 両方が連続観測で増えた時だけ URL を表示する。未到達なら 1 回自動再 publish する |

### 対応ブラウザ

| | H.264 | `setCodecPreferences` | WHIP | `degradationPreference` | 実効帯域 | 判定 |
|---|---|---|---|---|---|---|
| Chrome | あり | 有効 | 201 | 対応 | 500 kbps | **可** |
| Safari 26.5.2 | あり（`42e01f` / `640c1f`） | 有効 | 201 | 旧設定で対応 | **940 kbps** | **旧設定で可**。現行full設定は未確認で、R10どおり拒否時だけmaxBitrate-only fallbackで配信を継続する |
| Playwright 同梱 Chromium | あり | 有効 | 201 | 対応 | — | **可**。CI で回帰テストを回せる |
| Firefox | **未実測** | — | — | — | — | **判断保留** |

対応ブラウザではまずR10のfull設定を試す。Safari のfull設定での受理と実送出は未検証で、拒否時だけfresh parametersからmaxBitrate-only fallbackを1回だけ試す。このfallbackは配信継続の互換策であり、文字品質を保証しない。

**サーバー側の安全網**: MediaMTX は answer から Main / High プロファイルを落とすことが確認されている（High を先頭にした offer でも Baseline へ矯正された）。
ただし**これに依存せず、ブラウザ側で固定すること**（R1）。

## エンコードの契約（VRChat 互換）

VOD と同じ必須条件を維持する。詳細は [../encode-contract.md](../encode-contract.md)。

| 項目 | 値 | ライブでの扱い |
|---|---|---|
| コーデック | h264 | VOD と同じ |
| ピクセルフォーマット | yuv420p | VOD と同じ |
| プロファイル | baseline | VOD と同じ |
| B フレーム | なし | VOD と同じ |
| GOP | **通常 GOP** | **VOD の `-g 1` を持ち込まない**（30fps では 30 倍の無駄） |
| 音声 | **AAC**（出す場合） | R3 |
