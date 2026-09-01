# 開発用スクリプト

## `benchmark-screen-share-fps.ts`

実Macのsystem Chromeで、WebScreenの画面共有を指定順に取得し、H.264 loopback encoderの統計を比較する。解像度・bitrate・content hint・degradation preference・scale・keyframe間隔は製品moduleのexportを直接使う。音声は計測しない。

```bash
cd web
bun scripts/benchmark-screen-share-fps.ts
bun scripts/benchmark-screen-share-fps.ts --duration 15 --fps 24,30
bun scripts/benchmark-screen-share-fps.ts --mode screen
SCREEN_CAPTURE_SOURCE="Entire Screen" bun scripts/benchmark-screen-share-fps.ts --mode screen
```

既定のfps順は`24,30`で、`--fps`の順序と重複をそのまま実行する。thermal/order biasを相殺する本測定では、同じ条件で`--fps 24,30`と`--fps 30,24`をcounterbalanced実行する。

既定の`tab` modeはproduction secure originをcapture sourceだけに使い、controllerは外部JSのない`http://127.0.0.1` secure contextへ分離する。getDisplayMediaはcontrollerのPlaywright clickから呼ぶ。source名・window title・`--source`値はJSONへ出さない。`screen` modeはmacOS画面収録権限やcapture sourceに依存し、実機未検証である。

取得できない場合は15秒、各runが完了しない場合は指定時間+30秒で非ゼロ終了する。SIGINT/SIGTERMではChrome・localhost server・一時profileを冪等にcleanupしてから終了し、手動操作や権限回避は要求しない。

画面内容・screenshot・videoは保存しない。`capture.deliveryFramesPerSecond`はrequestVideoFrameCallbackによるcapture delivery、`h264Encode.encodedFramesPerSecond`は開始直前と終了時のoutbound counter差分によるH.264送出を表し、別指標として扱う。counter reset・identity変更・H.264以外・codec不明は結果を作らず失敗する。

captureのideal制約は1280×720だが、タブのaspect比により実測が1280×642などになることは不合格にしない。JSONにはtrack実測とH.264 output実測を分けて残す。loopback receiverは非表示videoで実際に`play()`し、受信側の省電力化を避ける。結果は環境依存であり、tab測定をscreenへ一般化しない。

loopback senderは製品と同じsendonly transceiverを使い、bitrate等をoffer前に設定する。keyframe要求はbaseline stats取得後に開始し、終了statsの直前に止めるため、要求数と集計区間を同じ境界で扱う。
