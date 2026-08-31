# 受信側（VRChat）の制約

**こちらから動かせない前提**をまとめる。設計がこの形しか取れない理由。

## 受けられる形式

| 形式 | PC（AVPro + Media Foundation） | Quest（AVPro + media3 ExoPlayer） |
|---|---|---|
| **`rtspt://`**（RTSP over TCP） | **最低遅延。日本の VRDJ の事実上の標準** | **✕ スキーム非対応** |
| `rtsp://`（UDP） | ○ | △ Android codec 起因で不安定の報告 |
| MPEG-TS over HTTP | ○ | ◎ VRCDN が Quest 向けに指定 |
| HLS (.m3u8) | ○ だが遅い（実測 35 秒） | ◎ 標準経路（実測 約 3 秒） |
| LL-HLS | **✕ 実効非対応**（実測 約 30 秒） | △ プレイヤーは対応するが VRChat 側の fMP4 音声バグ |
| プログレッシブ mp4 | ○（現行の WebScreen） | ○ |
| RTMP / SRT / WebRTC / DASH | **✕** | **✕** |

コーデックは **H.264 + AAC / MP4 が最大公約数**。**Opus 音声は Media Foundation で読み込み失敗**する。
VRChat 固有の解像度・ビットレート上限は公式に記載がない。

同一 URL・同一時刻での比較（VRChat feedback, 2025-08）: **PC HLS 35 秒 / Quest HLS 3 秒 / iOS 2 秒 / Android 1 秒**。
PC だけが桁違いに外れている。

## 到達できる最小遅延

| | 最小遅延 | 経路 | 条件 |
|---|---|---|---|
| **PC** | **0.3〜0.5 秒** | `rtspt://` + AVPro `Use Low Latency` **ON** | 下記のとおりワールド依存 |
| **Quest** | **約 3 秒** | HLS / MPEG-TS | `rtspt://` 非対応。実機実測 2.5〜3.8 秒 |

## PC の遅延はワールド作者が決める（こちらから制御できない）

`VRCAVProVideoPlayer.UseLowLatency` は **getter のみで setter がない**。
ワールドのアップロード時に焼き込まれる固定値で、**配信側も視聴者も実行時に変更できない**。

| ワールドの設定 | PC の遅延 |
|---|---|
| `Use Low Latency` ON | **0.3〜0.5 秒** |
| `Use Low Latency` OFF | **+8〜10 秒** |

**製品としての意味**: WebScreen が「超低遅延」を謳っても、**視聴されるワールド次第で 20 倍変わる**。
訴求できるのは「対応ワールドなら 0.5 秒」であって「常に 0.5 秒」ではない。対応ワールドの案内をドキュメントに置く必要がある。

また、ワールド側は **AVPro の Stream モード**である必要がある（VRChat 公式が Unity 標準 VideoPlayer は "does not support these live streams" と明記）。

## allowlist（自前ドメインで配ることの代償）

VRChat は**ホスト単位**の既定 allowlist（13 サービス: YouTube / Twitch / Vimeo / NicoNico / SoundCloud / Hyperbeam / `*.topaz.chat` / `*.vrcdn.live` 等）の外を再生しない。
**コンテンツ形式ではなくホストで判定するため、静的 mp4 の直リンクも例外ではない。**

> "If you have your own host outside of our allowlist, users must have the 'Allow Untrusted URLs' option enabled in their Settings to see your content."
> — VRChat 公式 Video Players（設定の既定は OFF）

さらに **2024.4.2 / Build 1552（2024-12-05）** で **Video Player Allowed Domains** が導入され、パブリックでは AND 条件になった:

| インスタンス種別 | 必要な条件 |
|---|---|
| Private / Friends | 視聴者が `Allow Untrusted URLs` を ON |
| **Public / Group Public** | 上記 **かつ** **ワールド作者**がワールド設定にドメインを登録（**上限 10・ワイルドカード非対応・既定は空**） |

**重要な切り分け: これはライブ配信で新たに増える制約ではない。**
`cdn.web-screen.net` の静的 MP4 も既にこの制約下にあり、それで本番稼働している = WebScreen は既にこの摩擦を受け入れている。

ただし「多くの人に使ってもらう」目的に対しては、**帯域をいくら最適化してもこの壁は下がらない**。
パブリックイベントで使ってもらうには、ワールド作者に 10 枠しかない登録枠を 1 つ割いてもらう必要がある。
VRCDN / TopazChat が既定 allowlist 入りなのは、技術投資では買えない価値。

## その他

| 項目 | 内容 |
|---|---|
| **Quest は HTTPS 必須** | "VRChat on Android will not play video if the host is not using HTTPS protocol."（`cdn.web-screen.net` は既に HTTPS なので追加コストなし） |
| URL 投入のレート制限 | ユーザーあたり 5 秒に 1 回のグローバル制限。リトライ設計に効く |
| **60 秒切断の既知問題** | VRChat の RTSP キープアライブ送信が遅く、MediaMTX の一部バージョンで接続タイムアウトする（gortsplib #932 で修正されたが、修正後も切れる報告が残る）。**ffmpeg クライアントでは再現しなかったため、実機で確認する必要がある**（[acceptance-test.md](acceptance-test.md) A5） |
| AVPro のバージョン | VRChat の AVPro は **v3.3.6**（Build 1864 / 2026-06-22, VRChat 2026.2.3）。上記の遅延実測値はすべて 2.x 時代のもので、**PC HLS 35 秒が現在も再現するかは未検証** |
