# 実装の必須要件と設定値

**実装するときはこのファイルを正本にする。** 数値の根拠は [verification.md](verification.md)、なぜこの構成かは [architecture.md](architecture.md)。

## 守らないと壊れるもの

| # | 要件 | 理由 |
|---|---|---|
| **R1** | ブラウザ側で `setCodecPreferences` により **H.264 を最優先に固定する** | 既定の受入順は `VP8, rtx, H264…` で **VP8 が選ばれる**。VP8 で publish しても MediaMTX はエラーを返さず素通しし、**VRChat 側で「再生できない」という静かな失敗**になる |
| **R2** | H.264 が使えない環境を**検出して配信を開始しない** | `RTCRtpSender.getCapabilities('video')` に H264 が無ければエラーにする。黙って VP8 で始めない |
| **R3** | 音声を出すなら **AAC へ変換する**（Opus のままにしない） | AVPro 公式が「Media Foundation では Opus は読み込み失敗」と明記。映像は `-c:v copy` のままでよく、CPU は 1 配信 0.77% |
| **R4** | `overridePublisher: no` を設定する | 既定 `true` は**後発の publisher が先発を蹴る**。他人の配信を奪える |
| **R5** | publish は path 単位の認証で保護する | JWT の `mediamtx_permissions` で `{action: publish, path: live/u_xxx}` を払い出す |
| **R6** | `hlsVariant: mpegts` を使う（LL-HLS を使わない） | LL-HLS は PC の AVPro が実効非対応、Quest も fMP4 の音声バグに当たる |
| **R7** | HTTPS で提供する | Quest は HTTPS 必須。`getDisplayMedia` も secure context 必須 |
| **R8** | **WHIP の UDP ポート（既定 8189/udp）を配信者から直接到達させる** | **Cloudflare の裏に隠せない**。配信ドメインとは別に、オリジンへ直接届く経路が要る |
| **R9** | 配信開始は**必ずユーザーのクリック起点**にする | `getDisplayMedia` はユーザージェスチャ必須。読み込み直後に呼ぶと Promise が解決も棄却もしない。**自動復帰・自動再開は構造的に作れない** |
| **R10** | `contentHint = 'text'` + `degradationPreference = 'maintain-resolution'` を設定する | **既定のままだと文字が読めなくなる**。実測で既定寄りの設定は 640x360 まで落ちて判読不能になった |
| **R11** | 送出解像度は `getSettings()` ではなく **`outbound-rtp` の `frameWidth/frameHeight`** で確認する | `ideal: 1920x1080` 要求で `getSettings()` が 1920x1080 を返しても、実送出は 1602x1032 だった |
| **R12** | 帯域の見積もりは **Safari 基準**で行う | 同一素材で Safari は Chrome の**約 1.9 倍**（940 kbps vs 500 kbps） |

## MediaMTX の設定

動作確認済みの雛形は [poc/mediamtx-poc.yml](poc/mediamtx-poc.yml)（検証用にポートをずらしてある。本番は既定ポートでよい）。

| 設定 | 値 | 補足 |
|---|---|---|
| バージョン | **v1.20.1 から試す**（大きい方から。ダメなら v1.15.5） | どちらでも検証結果は同一だった。互換性の推奨が調査間で割れており、実機でしか決着しない |
| `rtspTransports` | `[tcp, udp]` | VRChat の `rtspt://` は TCP を使う |
| `hlsVariant` | `mpegts` | R6 |
| `hlsAlwaysRemux` | `yes` | 視聴者ゼロでも生成し続け、初回視聴の生成待ちを消す |
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
| ビットレート上限 | `encodings[0].maxBitrate` | 1080p の静止テキストなら実効 604〜664 kbps |
| 劣化ポリシー | `degradationPreference = 'maintain-resolution'` | R10 |
| コンテンツヒント | `track.contentHint = 'text'` | R10 |
| 解像度 | **1920x1080 を既定**、720p を省帯域オプション。**480p は作らない** | 480p は 14px 以下が判読不能で、帯域を足しても直らない |
| 画面取得 | `getDisplayMedia({ preferCurrentTab: true })`（自タブ共有） | **画面全体の共有は macOS の画面収録許可が要り、未付与だとピッカーが解決しない。**自タブ共有はこれを回避でき 300ms で解決する |

### 対応ブラウザ

| | H.264 | `setCodecPreferences` | WHIP | `degradationPreference` | 実効帯域 | 判定 |
|---|---|---|---|---|---|---|
| Chrome | あり | 有効 | 201 | 対応 | 500 kbps | **可** |
| Safari 26.5.2 | あり（`42e01f` / `640c1f`） | 有効 | 201 | 対応 | **940 kbps** | **可**。提示順の先頭が High なので R1 が特に重要 |
| Playwright 同梱 Chromium | あり | 有効 | 201 | 対応 | — | **可**。CI で回帰テストを回せる |
| Firefox | **未実測** | — | — | — | — | **判断保留** |

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
