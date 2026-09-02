# 配信サーバーの運用（本番構成の正本）

コードとリポジトリを見ても分からない「本番がどう組まれているか」をここに固定する。
2026-09-01 に構築した実構成。設計の理由は [architecture.md](architecture.md)、数値の根拠は [verification.md](verification.md)。

## 全体像

```
ブラウザ --WHIP(HTTPS)--> Caddy --> ingress(WHIP 127.0.0.1:8889 / API 127.0.0.1:9997)
         --メディア(UDP 8189)----------------------^  | RTSP 127.0.0.1:8554
                                                     v
                             relay.sh / ffmpeg（H.264 copy / 任意音声を AAC-LC 48 kHz stereo 128 kbps）
                                                     |
                                                     v
VRChat --rtspt(TCP 554)--------------------------> egress(RTSP :554 / API 127.0.0.1:9998)
cron Worker --別 Bearer client--> ingress（publisher kick）/ egress（viewer・path 観測）
```

- **制限の実体は kick ではなく publish JWT の exp**（= 延長サイクル 2h。kick は再接続で迂回できるが、exp が切れたトークンでは再接続できない。Issue #127）
- 視聴（read）は無認証・公開。保護は 12 文字ランダム path のみ（動画と同じ思想）

## サーバー実体（どこに何があるか）

| 項目 | 値 |
|---|---|
| ホスト | WebARENA Indigo `161.34.34.128`（SSH: `ssh webscreen-indigo-poc`、鍵は ~/.ssh/config 参照） |
| MediaMTX | `/usr/local/bin/mediamtx`（v1.20.1）+ versioned config `/etc/webscreen/streaming` |
| relay | `/opt/webscreen/streaming/relay.sh`。映像 copy、音声があれば AAC 変換 |
| 常駐 | systemd `webscreen-mediamtx-ingress` / `webscreen-mediamtx-egress`。旧 `mediamtx.service` と `/etc/mediamtx/mediamtx.yml` は停止済み |
| TLS 終端 | Caddy `/etc/caddy/Caddyfile` + `/etc/caddy/mediamtx-api.env`（ingress / egress 別 token。root:root 600） |
| ログ | journald（上記2 unit を指定。/var/log/journal で永続） |
| DNS | Cloudflare。`webscreen.tv`（apex A → サーバー IP・**プロキシ OFF 必須**。凍結ドメイン、自動更新を切らない）/ `stream.web-screen.net`（A → 同 IP。API 専用で案内には使わない） |

ポート方針: 公開は **22 / 80 / 443 / 554(tcp) / 8189(udp)** のみ。8889（WHIP）、8554（ingress RTSP）、
9997（ingress API）、9998（egress API）は loopback。hls / rtmp / srt / moq と RTSP UDP transport は無効。

## Secrets の対応表（値はここに書かない）

| 名前 | 置き場所 | 用途 |
|---|---|---|
| `STREAM_JWT_PRIVATE_KEY` | 本体 Worker（wrangler secret） | publish JWT の署名。jwks はここから導出。ローカルに鍵の控えは無い（失くしたら再生成して MediaMTX 再起動で JWKS 再取得） |
| `MEDIAMTX_INGRESS_API_*` / `MEDIAMTX_EGRESS_API_*` | 本体 / cron Worker と Caddy env | ingress / egress Control API。token は別値にし、role marker も検証する。旧 `MEDIAMTX_API_*` は split の4値が全てない環境だけで使う |

生成手順は `web/.dev.vars.example` が正本。

## 動作確認コマンド（外形）

リポジトリ直下で `make stream-health` を実行する。Control API の 401、WHIP の 401、存在しない RTSP path の 404、JWKS の返却を順に確認する。

配信中の出口 codec・音量・L-R 差分は `make stream-probe ID=<12文字>`、両 MediaMTX の path / bytes は `make stream-paths`、journald は `make stream-logs MIN=15` を使う。

トークン付き確認はサーバー内で行い、別 token・期待する `X-WebScreen-MediaMTX-Role`・正しい token の 200・wrong token の 401 を両経路で確認する。値は端末へ出さない。
versioned 設定、VPS → Worker の cutover、Worker / VPS 一体 rollback は [MediaMTX relay 運用手順](../../web/streaming/README.md) を正本とする。

## cron（毎分 lifecycle）の検証方法

- `wrangler tail` は scheduled イベントを取りこぼす（実測）。**tail の沈黙を「動いていない」証拠にしない**
- 確実な検証: heartbeat 失効済みの合成 live 行を D1 に INSERT → 1〜2 分で `ended / heartbeat_lost` になれば cron・判定・API 呼び出しが一括で実証される（終わったら行を DELETE）
- cron トリガーを追加したデプロイの後は、CI ログの `schedule:` 表示を信用せず実効を確かめる。不発なら `bunx wrangler triggers deploy -c cron/wrangler.jsonc` の再実行で直った実績あり
- cron は ingress client で publisher を kick し、egress client で viewer / path を観測する。片側だけの疎通確認で完了にしない

## サーバーを移設・増設するとき

1. versioned ファイルから `/etc/webscreen/streaming`・`/opt/webscreen/streaming`・2つの systemd unit・Caddy env を構築し、FW を上記ポート方針に合わせる
2. split Control API と relay の smoke 後、[運用手順](../../web/streaming/README.md) の VPS → Worker 順で切り替える
3. Cloudflare で `webscreen.tv` と `stream.web-screen.net` の A レコードの向き先だけ変える（**ホスト名は凍結・変更不可**）
4. 両 API の外形確認、WHIP、H.264 + AAC、ingress / egress bytes 増加、VRChat 実機再生で受け入れる
5. 旧サーバーの Caddy 証明書は新サーバーで再取得される（80/443 開放が前提）

## 実機 E2E の作法

- ブラウザの画面ピッカーはネイティブ UI のため自動操作できない。**E2E は「人が配信開始 → AI が ffprobe / D1 / journalctl で検証」の協働型**で行う
- 検証観点: ffprobe で H.264 と、音声ありなら AAC-LC 48 kHz / stereo / 128 kbps + バックグラウンドタブで 10 分放置しても heartbeat_lost にならないこと
