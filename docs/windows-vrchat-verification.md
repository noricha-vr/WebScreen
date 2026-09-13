# Windows / VRChat 実機検証

WebScreen で生成した MP4 が VRChat で実際に表示・再生できることを確認する手順。
操作ツールは `web/scripts/windows-player-control.py`、動画検査は `web/scripts/video-check.py`。
choicast の Windows 対話タスク方式を基に移植し、このリポジトリだけで実行できる。

## 準備

Mac に Python 3、OpenSSH（ssh / scp）、ffprobe、通常の WebScreen 開発環境が必要。
接続先は環境変数だけで指定する。既定値はなく、全 SSH / SCP が同じ値を使う。

```bash
export VRCHAT_SSH_HOST=win2022  # 自分の ~/.ssh/config の Host 名に置き換える
make vrchat-status
```

ホスト名・IPv4・SSH の Host エイリアス（英数字、ハイフン、ドット、アンダースコア）を指定する。
ユーザー名、ポート、鍵などは SSH 設定で管理する。未設定・空白・制御文字・先頭ハイフン等は接続前に拒否する。
この変数は Mac の操作ツール専用。Worker / ブラウザ用 `.dev.vars` には追加しない。

Windows はログイン・ロック解除済みで、Steam / VRChat が利用可能な状態にしておく。
`status` の VRChat / explorer の SessionId と LogonUI、残留 WebScreenControl タスクを確認する。
ロック解除は自動化しない。別担当者と同時に PC 入力を行わない。

```bash
make vrchat-start       # 未起動の場合だけ。Steam への依頼であり起動成功の証明ではない
make vrchat-snapshot
```

画面は `docs/tmp/windows-player/screen.png` に保存される。毎回最新画像を読んでから次の操作を決める。
SSH の失敗と実機の停止は区別し、ネットワーク制限がある実行環境では許可された接続経路で確認する。

## 本番で検証動画を作る

1. `site-manual` / `agent-browser` スキルを参照し、専用タブで本番 WebScreen の既存ログインを確認する。
2. 日付と連番が大きく表示された PNG を 30 枚用意する。ブラウザ Canvas で描画して保存できる。個人情報や秘密情報は含めない。
3. 画像をファイル選択で順番に渡し、WebScreen の通常変換・アップロードが完了するまで待つ。検証動画は公開され、通常の保持期限で削除される。
4. プレビューの動画 URL を控える。形式は `https://cdn.web-screen.net/movies/{12文字の英数字}.mp4`。プレビュー HTML の URL は貼らない。

```bash
mkdir -p docs/tmp/windows-player
# URL は今回プレビューに表示された値に置き換える
export VIDEO_URL='https://cdn.web-screen.net/movies/Ab12Cd34Ef56.mp4'
curl --fail --show-error --location --max-time 120 "$VIDEO_URL" -o docs/tmp/windows-player/output.mp4
make video-check FILE=docs/tmp/windows-player/output.mp4
```

検査は moov が mdat より前にある通常の MP4、H.264 baseline、yuv420p、B フレームなし、全 I キーフレームを要求する。
`ftyp` だけの確認や HTTP 200 は、faststart や VRChat 実再生の証明にはならない。

## ワールドに入って再生する

非公開の検証用インスタンスを使う。確認済みの例は `[DEMO] iwaSync v3.6.15` の JP Invite。
他の利用者がいるインスタンスへ試験映像を投入しない。前の再生が Player Error になっていたら入り直す。
必要な Allow Untrusted URLs 設定が無効なら、VRChat の設定画面で確認する。

```bash
python3 web/scripts/windows-player-control.py key escape
python3 web/scripts/windows-player-control.py search-text iwaSync
python3 web/scripts/windows-player-control.py key enter
# 視点・移動・クリックは最新画像に応じて引数を決める
python3 web/scripts/windows-player-control.py --help
python3 web/scripts/windows-player-control.py look --help
python3 web/scripts/windows-player-control.py click --help
```

上記は入口の例であり、順番に実行する固定マクロではない。
ワールド内のボタンは画面中央の視線照準を合わせて中央をクリックする。メニューはカーソル座標で操作する。
画面を読む → 操作する → 新しい画面を読む、を繰り返す。

1. プレイヤーの **Video** を選び、URL 入力欄を押して入力ダイアログを開く。
2. 以下で貼付し、最新画像で今回の URL と一致することを確認する。Windows のクリップボードは上書きされる。
3. 一致を確認してから Enter で確定する。

```bash
make vrchat-paste URL="$VIDEO_URL"
# docs/tmp/windows-player/screen.png を読んでから確定する
python3 web/scripts/windows-player-control.py key enter
make vrchat-snapshot
```

貼付が失敗したら確定しない。クリップボード競合の場合は画像を確認して再試行する。
VRChat を前面にできない場合は入力前に失敗する。

## 合格判定・証拠・終了

- 検証画像がスクリーンに表示され、時間を置いた画像でフレーム番号と再生時刻の進行が確認できる。
- URL・日時・ワールド／プレイヤー・検査出力・スクリーンショットを `docs/tmp/<検証名>/` に保存する。`--out` で画像の上書きを避ける。
- 再生失敗時は入力 URL、エラー画面と必要なログを記録する。CLI の終了コード 0 だけで合格にしない。
- PC の実証を Quest・別プレイヤー・音声の合格に使わない。実機が利用できない場合は実再生未検証と記録する。
- 動画を再生終了まで待ち、`make vrchat-status` で一時タスクの残留がないことを確認する。専用ブラウザタブはスキルの解放手順で閉じる。

操作ごとに自分で作った一時タスクとファイルだけを終了時に削除する。SSH 切断で後始末できなければエラーを残す。
接続を復旧して status を確認し、今回のタスクであると特定してから後始末する。他のタスクは一括削除しない。
電源設定変更、常駐サービス、追加ポート開放は行わない。

## 確認済みの実績

2026-09-13: 本番 WebScreen で番号付き画像 30 枚を変換。
MP4 は `moov@32` / `mdat@945`、H.264 Constrained Baseline / yuv420p / B フレームなし。
Windows 11 の VRChat / iwaSync v3.6.15 の非公開インスタンスで、Frame 17 / 30 と再生時刻 16 秒の表示を確認した。
当時の証拠は `docs/tmp/faststart-20260913/`（Git 管理外）。これは移植前の手順による実績であり、ツール更新後の検証は別に記録する。

### WebScreen 専用ツールでの再確認

同日、`VRCHAT_SSH_HOST` を設定し、WebScreen 側の `vrchat-status` / `vrchat-snapshot` / `vrchat-paste` と操作 CLI だけで再確認した。
本番で新規生成した 45 枚の MP4 は `moov@32` / `mdat@1005`、全 45 フレームが I キーフレームで `make video-check` に合格。
iwaSync v3.6.15 上で Frame 20（19 秒）→ Frame 34（33 秒）の進行を別々の画像で確認した。
証拠は `docs/tmp/windows-verification-20260913/`。終了後の WebScreenControl タスク残留なし、検証用ブラウザタブ解放済み。

## ツールの自動テスト

```bash
make test-tools
make check
```

実機へは接続しない。MP4 の不正構造、faststart 違反、エンコード条件、接続先・URL の検証、SSH / SCP 共通接続先、失敗時の後始末を検査する。
