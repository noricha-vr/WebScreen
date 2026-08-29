# 検証環境（そのまま動く）

[../verification.md](../verification.md) の実測を再現するための一式。**本番用の実装ではない**。

検証用にポートを 28xxx / 29997 へずらしてある（他プロセスとの衝突を避けるため）。本番は MediaMTX の既定ポートでよい。

## 必要なもの

`mediamtx` / `ffmpeg` / `ffprobe` / `jq` / `node` / Google Chrome。
Playwright は `web/node_modules` のものを参照する（`run-publisher.mjs` 内の絶対パス）。

```bash
brew install mediamtx ffmpeg jq
```

## 使い方

```bash
# 1. サーバーを起動
./start-poc.sh

# 2. publisher 用の HTTP サーバー（別プロセス）
python3 -m http.server 28080 --bind 127.0.0.1 &

# 3. 検証を実行（引数は publish を維持する秒数）
./verify.sh 130      # V1 契約 / V2 途中参加 / V3 キーフレーム / V5 ビットレート / V6 HLS
./verify4.sh         # V7 reader あたりの CPU・RAM

# 後片付け
kill $(cat mediamtx.pid)
```

`run-publisher.mjs` は Chrome を起動して WHIP で publish する。**Chrome の ProcessSingleton がサンドボックス下で作れないため、
サンドボックス外で実行する必要がある**（Claude Code なら `dangerouslyDisableSandbox: true`）。

## ファイル

| ファイル | 役割 |
|---|---|
| `mediamtx-poc.yml` | MediaMTX の設定。**本番設定の雛形**（値の意味は [../requirements.md](../requirements.md)） |
| `whip-publisher.html` | 最小の WHIP publisher。**H.264 固定・ビットレート上限・contentHint の実装例**。画面にミリ秒時刻と日本語の文字梯子を描くので、遅延と可読性の測定に使える |
| `run-publisher.mjs` | Chrome を起動して上記ページを開き、指定秒数だけ配信を維持する |
| `start-poc.sh` | MediaMTX を起動して pid を残す |
| `verify.sh` | 契約・途中参加・キーフレーム・ビットレート・HLS の検証 |
| `verify2.sh` / `verify3.sh` | 遅延と負荷の測定（`verify4.sh` の前段。段階的に精度を上げたもの） |
| `verify4.sh` | **reader あたりの CPU を CPU 時間の差分で正確に測る**（`ps %cpu` は起動からの平均値なので使えない） |

## 実装へ持っていくもの

`whip-publisher.html` の次の部分がそのまま実装の要になる。

- `setCodecPreferences` による H.264 固定（これが無いと VP8 になり、VRChat で映らない）
- `degradationPreference = 'maintain-resolution'` と `contentHint`（これが無いと文字が読めなくなる）
- `outbound-rtp` から実際の送出コーデック・解像度・ビットレートを読む部分
