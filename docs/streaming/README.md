# ライブストリーミング（設計・検証）

Web ページを**リアルタイムに** VRChat のビデオプレイヤーへ映すための設計と検証結果。
配信セッション API・lifecycle 管理・配信 UI（/screen-share/）・ingress / egress の MediaMTX・音声 relay まで実装済み（2026-09-01）。
本番の実構成は [operations.md](operations.md) が正本。

[配信遅延ハーネス](latency-harness.md) — 実Macの画面共有からRTSPT出口を時系列計測するCLI。
[VRChat 実機 A/B の手順](vrchat-ab-runbook.md) — URL を 1 回貼るだけで設定候補を往復比較するコピペ用手順。

現行の変換（アップロード → MP4 → R2 配信）とは別系統の機能で、既存の動作には影響しない。

## 結論

**ブラウザの WebRTC(WHIP) → MediaMTX ingress → 映像 copy / 音声 AAC relay → MediaMTX egress → `rtspt://` → VRChat。**

| | 値 | 出所 |
|---|---|---|
| パイプライン遅延 | 約 100 ms（+ 実網の RTT と AVPro のバッファ） | 実測 |
| 送出上限 | **映像 1.2 Mbps + 音声 AAC 128 kbps**（入力 720p / 最大 30 fps、公称合計 1.328 Mbps） | [stability-audio-verification.md](stability-audio-verification.md) |
| 文字の可読性 | **本番 relay 合成QAは合格**（1280x720を維持し16 / 24pxは明瞭、12pxも判読可）。WebScreen UIからの actual YouTube は未検証 | [stability-audio-verification.md](stability-audio-verification.md) |
| 同時配信 | **全体 20 本 / 1 ユーザー 1 本** | API の原子的な上限 |
| 途中参加の待ち | 通常は最大 2 秒。Chrome のMP3 betaだけ次キーフレームを500 ms周期で要求（初回IDRは保証しない） | 実測 |
| PC | 同じYamaStreamのRTSPTで、AACは独立2回とも中央値1.239秒、MP3昇格候補は0.129〜0.416秒（16標本、中央値0.151秒、平均0.175秒）で全件1秒未満。ただしMP3音声はPC実機で無音のため昇格不可（[verification.md](verification.md) I23） | 実測 |
| Quest | PC と同じ `rtspt://`。AAC 音声を含め実機確認済み、体感 2〜3 秒 | 実測 |

**おすすめは現行AACを維持すること。** `stream-profile=mp3-beta` が重複なく1個だけあるChrome配信では、500 ms周期のキーフレーム要求を試せる。通常アクセス・unknown・重複値は従来の2秒GOPのままで、任意周期は指定できない。MP3 relayの30分・capacity・codec gateと実Macの30 / 24 fps比較は合格し、30 fpsを維持する。PC実聴はMP3音声が無音で不合格（I23）のため、MP3候補は本番へ投入しない。

## 読む順番

| ドキュメント | 中身 | いつ読むか |
|---|---|---|
| [architecture.md](architecture.md) | 構成と、その形にした理由・捨てた選択肢 | 全体像を掴む時。**最初に読む** |
| [operations.md](operations.md) | **本番実構成・secrets・移設の運用正本** | 本番を触る時・障害調査の時 |
| [requirements.md](requirements.md) | **実装の必須要件と確定した設定値** | 実装する時。**これが実装の正本** |
| [quality-tiers.md](quality-tiers.md) | **画質の段と、それが収容人数に与える影響**（実測） | 画質を決める時 |
| [stability-audio-verification.md](stability-audio-verification.md) | **現行の 720p入力 / 30 fps / 映像1.2 Mbps / 音声 / 再接続の決定と実測** | 配信がカクつく・音が出ない時 |
| [MediaMTX relay 運用手順](../../web/streaming/README.md) | **リポジトリ同梱の versioned 設定と具体的な cutover / rollback 手順** | `operations.md` に沿って更新・復旧する時 |
| [server-plan.md](server-plan.md) | **サーバーの推奨と段階計画・見積もり** | サーバーを選ぶ時・契約する時 |
| [scale-plan.md](scale-plan.md) | **複数ノード化の決定・段階（M1〜M4）・origin 移設手順・edge 追加条件** | 2 台目を足す時・Cherry へ移す時・自宅回線を足す時 |
| [region-and-traffic-plan.md](region-and-traffic-plan.md) | **どのリージョンに置くか・転送量枠の買い方（Cherry の課金モデル）** | 移設先を選ぶ時・転送量が枠に近づいた時 |
| [capacity.md](capacity.md) | 収容人数の計算式と事業者の一覧 | 数字を自分で計算し直す時 |
| [vrchat-constraints.md](vrchat-constraints.md) | 受信側（VRChat）の制約。動かせない前提 | 「なぜこの形しか取れないのか」を確認する時 |
| [verification.md](verification.md) | 実測の結果と手順。何を確かめ、何を確かめていないか | 数字の根拠を辿る時 |
| [acceptance-test.md](acceptance-test.md) | **VRChat 実機での受け入れテスト手順** | **実装に着手する前に必ず実施** |
| [poc/](poc/) | そのまま動く検証環境一式 | 手を動かして確かめる時 |

## 現在地

- 机上調査と**ローカル実測は完了**（[verification.md](verification.md)）
- **Indigo 実機と VRChat PC 実機の確認も完了**（2026-08-31。verification.md の I1〜I6）:
  UDP 疎通・持続帯域・A1 契約・A2（映る）・A5（5 分以上切断なし）・A6（途中参加 2 秒以内）に合格し、
  **MediaMTX v1.20.1 を採用で確定**（A8）
- A3（低遅延）、A7（Quest RTSP）、動画素材のビットレート比較、音声 AAC は実機確認済み。
- 現行の安定性対策は 720p入力 / 30 fps / 映像1.2 Mbps、出口 bytes の到達確認、1 回の自動再接続。設定値と最新の計測は
  [stability-audio-verification.md](stability-audio-verification.md) を正本とする。
