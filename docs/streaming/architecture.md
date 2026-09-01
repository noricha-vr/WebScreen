# 構成と、その形にした理由

結論だけ要る場合は [README.md](README.md)、実装する場合は [requirements.md](requirements.md) を見る。

## 構成

```
ユーザーのブラウザ
  getDisplayMedia（画面・ウィンドウ・タブ。タブ音声は任意）
  → RTCPeerConnection（H.264 Baseline を明示固定）
  → WHIP (HTTP POST)
        │  ※ UDP が配信者から直接届く必要がある（Cloudflare の裏に置けない）
        ▼
   MediaMTX ingress（WHIP / publish JWT）
     → ffmpeg relay（H.264 copy / 音声だけ AAC-LC へ変換）
     → MediaMTX egress（公開 RTSP read）
       └─ rtspt://webscreen.tv/live/{id} ─→ VRChat PC / Quest
```

## なぜこの形なのか

### 経路が `rtspt://` しかない

VRChat のビデオプレイヤーが受けられる形式のうち、低遅延なのは実質これだけ。
WebRTC・SRT・RTMP・DASH は**受信できない**ため、配信サービスの選択肢が最初に大きく削られる。
詳細は [vrchat-constraints.md](vrchat-constraints.md)。

### 低遅延にすると CDN が使えなくなる

HLS は「連番の静的ファイル」なのでキャッシュでき、視聴者が何人でもオリジンの上りは 1 本分で済む。
一方 `rtspt://` は**視聴者ごとのユニキャスト**でキャッシュできず、**出口帯域が視聴者数の上限**になる。

この差により、設計の力点が変わる:

| | HLS + CDN | `rtspt://`（採用） |
|---|---|---|
| 視聴者数の上限 | 実質なし | **サーバーの帯域と CPU** |
| 画質と視聴者数の関係 | 無関係 | **画質を上げると人数が減る** |
| 遅延 | PC で 35 秒 | **同じYamaStreamのRTSPTで、AACは中央値1.239秒、MP3昇格候補は中央値0.151秒（全16標本1秒未満）。QuestのMP3音声は未確認のため本番はAACを維持** |

「画質を落として多くの人に配る」という発想が意味を持つのは、この低遅延構成だからこそ。計算は [capacity.md](capacity.md)。

### サーバーでは映像を再エンコードしない（WebRTC ingest の効果）

当初は「サーバーでヘッドレス Chromium を動かして画面を撮り、x264 でエンコードする」形を想定していた。
これだと**配信 1 本あたり 1〜2 vCPU** かかり、同時配信本数が最初の壁になる。

ブラウザから WebRTC で送る形にすると、**映像エンコードはユーザーのブラウザが行う**ため、サーバーは H.264 を copy するだけで済む。
ブラウザが出す H.264 がそのまま VRChat 互換の条件を満たすことは実測で確認済み（[verification.md](verification.md) V1）。
ブラウザ音声は Opus なので、VRChat 互換のため relay で AAC-LC 48 kHz / stereo / 128 kbps にだけ変換する。

**この結果、2 つの配信形態を区別する必要がある:**

| 形態 | 実現方法 | サーバー CPU | 状態 |
|---|---|---|---|
| **ユーザー在席型** | ユーザーのブラウザが送る | **映像 copy + 音声だけ AAC** | 本設計の対象 |
| サーバー生成型 | サーバーでヘッドレスブラウザ + x264 | 1 配信あたり 1〜2 vCPU | 将来。スケジュール配信・常設チャンネル向け |

### Quest も PC と同じ RTSP 出口を使う

Quest 実機で `rtspt://webscreen.tv/live/{id}` の映像と AAC 音声を確認済み。PC と URL を分けず、
HLS は実装しない。配信元時計から本番 RTSPT 出口までは 1 秒未満（I19）だが、Quest の体感遅延は 2〜3 秒である。
これは Quest/VRChat 受信経路側に残る現状境界であり、network 受信後の decode / render / buffer の具体的要因と値は未確認。
PCの同じYamaStreamでは、RTSPTの動画のみが中央値0.059秒、H.264/AACが独立2回とも中央値1.239秒だった。実Mac動的H.264 + MP3候補は16標本すべて1秒未満（0.129〜0.416秒、中央値0.151秒、平均0.175秒）で、AVProは映像とMPEG-1/2 Audioの2トラックを選択した。ただしMP3音声の実聴、Quest、30分、capacity、同条件の24 fpsは未確認なので本番AACから昇格しない。RTMPは一時有効化時にH.264/AACを取得できたが、現行YamaStreamのMedia Foundation経路ではLoading failedとなりA/B不能で、検証後に無効へ戻した。`Use Low Latency` の実値も未確認である。

### ingress / egress を分ける理由

WHIP publisher と公開 RTSP reader を別プロセスにすると、公開権限と Control API token を分離できる。
ingress は publish JWT を検証し、egress は loopback からの relay publish だけを許可する。Worker は両方の bytes を観測し、
ブラウザから出口まで実データが流れた時だけ配信開始と判定する。

## 捨てた選択肢

| 選択肢 | 捨てた理由 |
|---|---|
| **HLS 単独**（当初案） | PC の遅延が実測 35 秒。要件（超低遅延）を満たさない |
| **LL-HLS**（1〜2 秒帯の中間解） | PC の AVPro が実効非対応（RenderHeads 社員の実測で約 30 秒）。Quest も fMP4 の音声バグに当たる |
| **転送量無制限の VPS を借りる** | さくら / ConoHa / Xserver は最上位プラン（月 3〜6 万円）でも出口 100 Mbps 固定で、**帯域を金で買えない**。約款上も「計算資源の恒常的占有」は禁止されている（[capacity.md](capacity.md)） |
| **外部の配信 SaaS に逃がす** | 技術的に適合する 5 サービスすべてが規約・地理・人数上限のいずれかで欠格。VRCDN は T&C が第三者提供を明示的に禁止（[capacity.md](capacity.md)） |
| **Cloudflare の CDN でオリジンを隠す** | Cloudflare は「動画は Stream / Images / R2 等の有償サービス経由で配れ」と規約で定めており、通常の CDN プロキシで動画を配るのは違反。加えて WHIP は UDP なので技術的にも通せない |
| **MediaMTX で MPEG-TS を Quest へ出す** | MediaMTX の MPEG-TS は**入力専用**で出力できない。HLS で同じ遅延が出るので不要 |

## 既存の契約との関係

`docs/encode-contract.md` は「エンコード系統はブラウザの FFmpeg.wasm の 1 つだけ / サーバー側に第 2 のエンコーダを置かない」と定めている。

ライブ配信ではブラウザの WebRTC が映像を作り、サーバー relay は映像を copy して音声だけ AAC に変換する。
VOD の FFmpeg.wasm と責務を混ぜず、`docs/encode-contract.md` ではライブを明示的な別契約として扱う。

VRChat 互換の必須パラメータ（h264 / yuv420p / baseline / B フレームなし）は**ライブでもそのまま維持する**。
GOP だけは例外で、VOD の `-g 1`（全キーフレーム）を 30fps のライブに持ち込むと 30 倍の無駄になるため、通常 GOP に戻す。
