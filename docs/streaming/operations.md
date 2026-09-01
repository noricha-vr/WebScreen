# 配信サーバーの運用（本番構成の正本）

コードとリポジトリを見ても分からない「本番がどう組まれているか」をここに固定する。
2026-09-01 に構築した実構成。設計の理由は [architecture.md](architecture.md)、数値の根拠は [verification.md](verification.md)。

## 全体像

```
ブラウザ(配信者) --WHIP(HTTPS)--> Caddy(webscreen.tv:443) --> MediaMTX(127.0.0.1:8889)
ブラウザ(配信者) --メディア(UDP)--> MediaMTX(:8189)
VRChat(視聴者)  --rtspt(TCP 554)--------------------------> MediaMTX(:554・匿名 read)
cron Worker     --Bearer(HTTPS)--> Caddy(stream.web-screen.net:443) --> MediaMTX API(127.0.0.1:9997)
MediaMTX        --JWKS 取得-----> https://web-screen.net/api/streams/jwks/（publish JWT の検証鍵）
```

- **制限の実体は kick ではなく publish JWT の exp**（= 延長サイクル 2h。kick は再接続で迂回できるが、exp が切れたトークンでは再接続できない。Issue #127）
- 視聴（read）は無認証・公開。保護は 12 文字ランダム path のみ（動画と同じ思想）

## サーバー実体（どこに何があるか）

| 項目 | 値 |
|---|---|
| ホスト | WebARENA Indigo `161.34.34.128`（SSH: `ssh webscreen-indigo-poc`、鍵は ~/.ssh/config 参照） |
| MediaMTX | `/usr/local/bin/mediamtx`（v1.20.1）+ `/etc/mediamtx/mediamtx.yml` |
| 常駐 | systemd `mediamtx.service`（enabled・Restart=always・`AmbientCapabilities=CAP_NET_BIND_SERVICE` で 554 直接バインド。**root では動かさない**） |
| TLS 終端 | Caddy `/etc/caddy/Caddyfile` + `/etc/caddy/mediamtx-api.env`（API トークン。root:root 600、systemd override の EnvironmentFile で注入） |
| ログ | journald（`journalctl -u mediamtx`。/var/log/journal で永続） |
| DNS | Cloudflare。`webscreen.tv`（apex A → サーバー IP・**プロキシ OFF 必須**。凍結ドメイン、自動更新を切らない）/ `stream.web-screen.net`（A → 同 IP。API 専用で案内には使わない） |

ポート方針: 公開は **22 / 80 / 443 / 554(tcp) / 8189(udp) / 8000-8001(udp・RTSP UDP transport)** のみ。
8889（WHIP）と 9997（API）は localhost バインドで Caddy 経由。hls / rtmp / srt / moq は設定で無効。

## Secrets の対応表（値はここに書かない）

| 名前 | 置き場所 | 用途 |
|---|---|---|
| `STREAM_JWT_PRIVATE_KEY` | 本体 Worker（wrangler secret） | publish JWT の署名。jwks はここから導出。ローカルに鍵の控えは無い（失くしたら再生成して MediaMTX 再起動で JWKS 再取得） |
| `MEDIAMTX_API_URL` / `MEDIAMTX_API_TOKEN` | cron Worker（`-c cron/wrangler.jsonc`） | Control API 呼び出し。URL は **HTTPS origin 直下限定**（パス不可 = mediamtx.ts の検証）。トークンはサーバー側 `/etc/caddy/mediamtx-api.env` と同値 |

生成手順は `web/.dev.vars.example` が正本。

## 動作確認コマンド（外形）

```bash
curl -s -o /dev/null -w "%{http_code}" https://stream.web-screen.net/v3/paths/list      # 401 = Bearer ガード生存
curl -s -X POST -H "Content-Type: application/sdp" --data "v=0" \
  -o /dev/null -w "%{http_code}" https://webscreen.tv/live/x/whip                        # 401 = publish JWT 必須
ffprobe -rtsp_transport tcp rtsp://webscreen.tv/live/nonexistent000                      # 404 = 匿名 read 可・path なし
curl -s https://web-screen.net/api/streams/jwks/ | head -c 100                           # keys が返る = 秘密鍵投入済み
```

トークン付きの API 確認はサーバー内で完結させる（値を手元に出さない）:
`ssh webscreen-indigo-poc 'TOKEN=$(sudo grep -o "MEDIAMTX_API_TOKEN=.*" /etc/caddy/mediamtx-api.env | cut -d= -f2); curl -s -H "Authorization: Bearer $TOKEN" https://stream.web-screen.net/v3/paths/list'`

## cron（毎分 lifecycle）の検証方法

- `wrangler tail` は scheduled イベントを取りこぼす（実測）。**tail の沈黙を「動いていない」証拠にしない**
- 確実な検証: heartbeat 失効済みの合成 live 行を D1 に INSERT → 1〜2 分で `ended / heartbeat_lost` になれば cron・判定・API 呼び出しが一括で実証される（終わったら行を DELETE）
- cron トリガーを追加したデプロイの後は、CI ログの `schedule:` 表示を信用せず実効を確かめる。不発なら `bunx wrangler triggers deploy -c cron/wrangler.jsonc` の再実行で直った実績あり

## サーバーを移設・増設するとき

1. 新サーバーに `/usr/local/bin/mediamtx`・`/etc/mediamtx/`・`/etc/caddy/`（Caddyfile + mediamtx-api.env + systemd override）・`mediamtx.service` を複製し、FW を上記ポート方針に合わせる
2. Cloudflare で `webscreen.tv` と `stream.web-screen.net` の A レコードの向き先だけ変える（**ホスト名は凍結・変更不可**。requirements.md「配信ホスト名と path 規則」）
3. 外形確認コマンド 4 本 + VRChat 実機再生で受け入れ
4. 旧サーバーの Caddy 証明書は新サーバーで再取得される（80/443 開放が前提）

## 実機 E2E の作法

- ブラウザの画面ピッカーはネイティブ UI のため自動操作できない。**E2E は「人が配信開始 → AI が ffprobe / D1 / journalctl で検証」の協働型**で行う
- 検証観点: ffprobe で h264 / Baseline / yuv420p / B フレーム 0（encode-contract）+ バックグラウンドタブで 10 分放置しても heartbeat_lost にならないこと（タブのタイマー絞りの回帰検知）
