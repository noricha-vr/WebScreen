# エンコード契約（VRChat 互換 mp4）

VRChat のビデオプレイヤーで再生できる mp4 の必須条件。**この条件を満たさない出力は不良品**として扱う。

## エンコード系統は 1 つだけ

動画化はブラウザ上の **FFmpeg.wasm の 1 系統のみ**で行う。サーバー側に第 2 のエンコーダを置かない。

- web-capture サービスは**スクリーンショット画像を返すだけ**で、動画化しない（責務は撮影と順序保証のみ）
- 画像 → 動画の変換はすべてクライアントの FFmpeg.wasm が担当し、成果物を R2 へ直接アップロードする
- 理由: エンコード系統が 2 つあると VRChat 互換パラメータが二重管理になり、片方だけ壊れても気づけない

## 必須パラメータ

| 項目 | 値 | 理由 |
|------|-----|------|
| コーデック | h264 | VRChat のプレイヤーが確実に扱える唯一の選択肢 |
| ピクセルフォーマット | yuv420p | yuv444p / yuv422p は再生できない環境がある |
| プロファイル | baseline | high プロファイルの機能（CABAC 等）でデコードに失敗する |
| B フレーム | `bf=0` | B フレームがあるとシーク時に破綻する |
| GOP | `g=1`（全フレームキーフレーム） | 任意フレームへの即時シークを可能にする。ファイルサイズと引き換え |
| moov 配置 | `-movflags +faststart` | ストリーミング再生の開始待ちをなくす（moov を先頭へ） |
| 音声 | なし可 | 静止画スライド用途では音声トラック不要 |

## ffmpeg コマンド例

```bash
ffmpeg -framerate 1 -i '%04d.png' \
  -c:v libx264 -pix_fmt yuv420p -profile:v baseline \
  -bf 0 -g 1 -movflags +faststart \
  output.mp4
```

## 検証コマンド

```bash
# コーデック / プロファイル / ピクセルフォーマットを一括確認
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,profile,pix_fmt,has_b_frames \
  -of default=noprint_wrappers=1 output.mp4

# 期待値
#   codec_name=h264
#   profile=Constrained Baseline  （または Baseline）
#   pix_fmt=yuv420p
#   has_b_frames=0

# 全フレームがキーフレームか（出力が全部 K なら g=1 を満たす）
ffprobe -v error -select_streams v:0 \
  -show_entries frame=pict_type -of csv=p=0 output.mp4 | sort -u

# faststart（moov が mdat より前にあるか）
ffprobe -v trace -i output.mp4 2>&1 | grep -o 'type:.moov\|type:.mdat' | head -2
```

## 関連

- API の契約（撮影順序の保証を含む）: [api-contracts.md](api-contracts.md)
- 型の正本: `web/src/lib/contracts/api.ts`
- ライブ配信（**未実装**。実装時にこの契約の改定を伴う）: [streaming/](streaming/)

ライブ配信を実装する場合、エンコードはユーザーのブラウザの WebRTC が行う。
**サーバー側にエンコーダは増えない**が、「エンコード系統は 1 つだけ」の節は改定が要る。
上記の必須パラメータは維持し、GOP だけ例外（`g=1` は 1fps のスライドでは実質無料だが、
30fps のライブでは 30 倍の無駄になるため通常 GOP に戻す）。詳細は [streaming/architecture.md](streaming/architecture.md)。
