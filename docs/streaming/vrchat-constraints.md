# 受信側（VRChat）の制約

**こちらから動かせない前提**をまとめる。設計がこの形しか取れない理由。

## 受けられる形式

| 形式 | PC（AVPro + Media Foundation） | Quest（AVPro + media3 ExoPlayer） |
|---|---|---|
| **`rtspt://`**（RTSP over TCP） | **最低遅延。日本の VRDJ の事実上の標準** | **○ WebScreen + MediaMTX v1.20.1 で映像・AAC 音声を実機確認** |
| `rtsp://` | ○ | ○（8554 明示でも実機確認。製品案内は TCP の `rtspt://` に統一） |
| MPEG-TS over HTTP | ○ | ◎ VRCDN が Quest 向けに指定 |
| HLS (.m3u8) | ○ だが遅い（実測 35 秒） | ◎ 標準経路（実測 約 3 秒） |
| LL-HLS | **✕ 実効非対応**（実測 約 30 秒） | △ プレイヤーは対応するが VRChat 側の fMP4 音声バグ |
| プログレッシブ mp4 | ○（現行の WebScreen） | ○ |
| RTMP / SRT / WebRTC / DASH | **✕** | **✕** |

コーデックは本番の **H.264 + AAC / MP4 が最大公約数**。RTSPTのOpusとG.711はAVProが映像だけを選択した。MP3候補は実Mac動的H.264でH.264 + MPEG-1/2 Audioの2トラックを選択し、PC映像と低遅延を確認した。30分連続配信と実Mac 24/30 fps比較は合格したが、本番へ一時投入した際にPC実機で**MP3音声が無音**（relay出口は非無音、AVProは2トラック受信）で、AACへ戻すと聞こえたためAACから昇格しない（2026-09-02実測、[verification.md](verification.md) I23）。
VRChat 固有の解像度・ビットレート上限は公式に記載がない。

同一 URL・同一時刻での比較（VRChat feedback, 2025-08）: **PC HLS 35 秒 / Quest HLS 3 秒 / iOS 2 秒 / Android 1 秒**。
PC だけが桁違いに外れている。

## 到達できる最小遅延

| | 最小遅延 | 経路 | 条件 |
|---|---|---|---|
| **PC** | **RTSPT動画のみ0.059秒 / AAC 1.239秒 / MP3候補0.151秒** | 同じYamaStreamのRTSPT実測 | MP3候補は16標本すべて1秒未満（0.129〜0.416秒、平均0.175秒）。ただし2トラック選択を音声実聴とは扱わず、PC限定の候補値。実聴ではMP3音声は無音（I23） |
| **Quest** | **体感 2〜3 秒** | PC と同じ `rtspt://webscreen.tv/live/{id}` | Quest/VRChat 受信経路側に残る現状境界。network 受信後の decode / render / buffer の具体的要因と値は未確認。URL は一本化できるが、サーバー設定だけで 1 秒未満は保証できない |

## PC の遅延はワールド作者が決める（こちらから制御できない）

`VRCAVProVideoPlayer.UseLowLatency` は **getter のみで setter がない**。
ワールドのアップロード時に焼き込まれる固定値で、**配信側も視聴者も実行時に変更できない**。

| ワールドの設定 | PC の遅延 |
|---|---|
| 過去RTMP映像条件 | **約0.08秒**。Quest対応前に同じYamaStreamで測定。RTSPTとの差は未切り分け |
| YamaStream（RTSPT動画のみ） | **0.026〜0.080秒、6標本の中央値0.059秒**（30 fps録画の分解能約0.033秒）。同じH.264映像・AVPro・ワールドで1秒以下 |
| YamaStream（RTSPT H.264/AAC） | **17標本・独立12標本とも中央値1.239秒**。独立12標本は1.157〜1.321秒、平均1.237秒。音声付き1秒以下は未合格 |
| YamaStream（RTSPT H.264/MP3候補） | **16標本すべて1秒未満、中央値0.151秒**。映像と2トラック選択は確認したがPC実聴で音声は無音（I23）。Questは未確認 |
| `Use Low Latency` 実値 | 現行ワールドのログから未確認。設定値や遅延への効果は断定しない |

**製品としての意味**: WebScreen が「超低遅延」を謳っても、**視聴されるワールド次第で大きく変わる**。
YamaStreamの単一実測をPCワールド全般へ一般化しない。AACは中央値1.239秒、MP3候補は中央値0.151秒として分ける。RTMPは現行Media Foundation経路でLoading failedとなり比較不能だった。公開前に対象ワールドと音声条件を個別に測り、Quest実聴前は本番AACを維持する。Windows の設定説明は [AVPro documentation](https://www.renderheads.com/content/docs/AVProVideo/articles/inline-component-media-player-properties-windows.html) を参照。

また、ワールド側は **AVPro の Stream モード**である必要がある（VRChat 公式が Unity 標準 VideoPlayer は "does not support these live streams" と明記）。

## allowlist（自前ドメインで配ることの代償）

VRChat は**ホスト単位**の既定 allowlist（13 サービス: YouTube / Twitch / Vimeo / NicoNico / SoundCloud / Hyperbeam / `*.topaz.chat` / `*.vrcdn.live` 等）の外を再生しない。
**コンテンツ形式ではなくホストで判定するため、静的 mp4 の直リンクも例外ではない。**

> "If you have your own host outside of our allowlist, users must have the 'Allow Untrusted URLs' option enabled in their Settings to see your content."
> — VRChat 公式 Video Players（設定の既定は OFF）

さらに **2024.4.2 / Build 1552（2024-12-05）** で **Video Player Allowed Domains** が導入され、パブリックでは AND 条件になった:

| インスタンス種別 | 必要な条件 |
|---|---|
| Private | 視聴者が `Allow Untrusted URLs` を ON |
| Friends | 視聴者が `Allow Untrusted URLs` を ON |
| Friends+ | 視聴者が `Allow Untrusted URLs` を ON |
| **Public / Group Public** | 視聴者の同設定が ON **かつ** ワールド作者がワールド設定にドメインを登録（**上限 10・ワイルドカード非対応・既定は空**） |

YamaStream の 2026-09-02 実測では、Public の `urlList` が空で `webscreen.tv` を許可しておらず、AccessDenied のまま MediaMTX egress reader が 0 本だった。これは RTSP 接続前の拒否である。Friends+ では `Allow Untrusted URLs` を有効化して再生できた。Public で使うにはワールド作者が `webscreen.tv` を Allowed Domains へ登録する必要がある。

**重要な切り分け: これはライブ配信で新たに増える制約ではない。**
`cdn.web-screen.net` の静的 MP4 も既にこの制約下にあり、それで本番稼働している = WebScreen は既にこの摩擦を受け入れている。

ただし「多くの人に使ってもらう」目的に対しては、**帯域をいくら最適化してもこの壁は下がらない**。
パブリックイベントで使ってもらうには、ワールド作者に 10 枠しかない登録枠を 1 つ割いてもらう必要がある。
VRCDN / TopazChat が既定 allowlist 入りなのは、技術投資では買えない価値。

## その他

| 項目 | 内容 |
|---|---|
| **Quest の HTTP 系 URL は HTTPS 必須** | 静的 MP4 / HLS の HTTP 配信に対する制約。RTSP は `rtspt://webscreen.tv/...` を実機確認済み |
| URL 投入のレート制限 | ユーザーあたり 5 秒に 1 回のグローバル制限。リトライ設計に効く |
| **60 秒切断の既知問題** | MediaMTX v1.20.1 + VRChat PC 実機で 7 分以上の単一 RTSP セッションを確認し、再現しなかった。バージョン更新時は [acceptance-test.md](acceptance-test.md) A5 を再実行する |
| **開始直後のカクつき** | actual YouTube の既存観測では約 30 秒で自然に安定。まず 30 秒待ち、継続時は ingress / egress bytes を確認する。relay 未到達の場合だけ再接続し、到達済みなら再接続を合格手順にしない。無条件の再起動は案内しない |
| AVPro のバージョン | RTSPTのAAC / 動画のみ / MP3候補は **AVPro v3.3.6 Media Foundation** で実測。PC HLS 35秒は2.x時代の値で現在も再現するか未検証。RTMPはv3.3.6 Media FoundationでLoading failed |
