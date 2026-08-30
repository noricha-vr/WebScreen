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

## 1 ページの上限枚数（150 枚）

全キーフレームなので**全フレームが I フレーム**になり、mp4 のサイズは枚数にほぼ正比例する
（下表は 100→300 枚で誤差 0.3% 以内）。1 枚 = 1 秒・アップロード上限 50 MiB（`MAX_UPLOAD_BYTES`）から、
**1 ページあたり 150 枚**を上限とする（正本は `web/src/lib/contracts/api.ts` の `MAX_CAPTURE_IMAGES`。
web-capture は同じ値を `app/models.py` に持ち、撮影前に弾く）。

実測（2026-08-31。1920x1080 の JPEG q80 を上のコマンドと同じ引数でネイティブ ffmpeg 8.0.1 に通した値。
ユニークな 44 / 12 枚を循環させて枚数を作った。全 I フレームなので 1 枚あたりのサイズは繰り返しても変わらない）:

| ページの中身 | 100 枚 | 200 枚 | 300 枚 | 1 枚あたり |
|---|---|---|---|---|
| 文字主体（Wikipedia の長い記事） | 25.0 MiB | **50.1 MiB**（上限超過） | 75.1 MiB | 262 KB |
| 画像主体（Wikimedia Commons の写真ギャラリー） | 18.7 MiB | 37.5 MiB | 55.9 MiB | 195 KB |

- **重いのは写真ではなく文字**（細い字形の高周波成分が全 I フレームだと毎フレーム効く）。上限は文字主体の値で決める
- 上限 = 50 MiB × 安全率 ÷ 262 KB。無補正だと 199 枚でちょうど張り付くので、実測より 1.3 倍重いページでも収まる 150 枚を採る（150 枚 = 約 37.6 MiB、上限の 75%）
- 本番の FFmpeg.wasm（@ffmpeg/core 0.12.10）で 44 枚を実測すると 10.36 MiB、同じ枚数のネイティブは 11.00 MiB。**実機の方が 6% 小さい**ので上表は安全側の見積もり

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
