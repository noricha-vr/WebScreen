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

- **実際の終了は毎分 cron の期限判定と publisher kick**（`web/src/lib/services/stream-lifecycle.ts`）。期限から kick までは cron 間隔により最大約1分の遅延がある。publish JWT の `exp` は期限後の再 publish を防ぐ補助ゲートであり、終了の実体ではない。ベータ版は15分で、画面の延長は無効（Issue #127）。
- 視聴（read）は無認証・公開。保護は 12 文字ランダム path のみ（動画と同じ思想）

## サーバー実体（どこに何があるか）

| ノード | 役割 | 実体 | 常駐 unit |
|---|---|---|---|
| Indigo | **origin**（WHIP 受け + relay + read） | WebARENA Indigo `161.34.34.128`（SSH: `ssh webscreen-indigo-poc`、鍵は ~/.ssh/config 参照）。ufw は inactive で、ポート開放は WebARENA ポータルの FW で行う | `webscreen-mediamtx-ingress` / `webscreen-mediamtx-egress` |
| 2 台目 | **read replica**（read のみ） | **未構築**（ホスト・IP・SSH alias とも未定） | `webscreen-mediamtx-egress-replica` のみ |

origin ノードの中身:

| 項目 | 値 |
|---|---|
| MediaMTX | `/usr/local/bin/mediamtx`（v1.20.1）+ versioned config `/etc/webscreen/streaming` |
| relay | `/opt/webscreen/streaming/relay.sh`。映像 copy、音声があれば AAC 変換 |
| 常駐 | 旧 `mediamtx.service` と `/etc/mediamtx/mediamtx.yml` は停止済み（現行 unit は上表） |
| TLS 終端 | Caddy `/etc/caddy/Caddyfile` + `/etc/caddy/mediamtx-api.env`（ingress / egress 別 token。root:root 600） |
| ログ | journald（上記2 unit を指定。/var/log/journal で永続） |
| DNS | Cloudflare。`webscreen.tv`（apex A → **全 read ノード**の IP・**プロキシ OFF 必須**。凍結ドメイン、自動更新を切らない。TTL 300 秒）/ `stream.web-screen.net`（A → origin の IP。Control API 専用で案内には使わない） |

ポート方針: 公開は **22 / 80 / 443 / 554(tcp) / 8189(udp)** のみ。8889（WHIP）、8554（ingress RTSP）、
9997（ingress API）、9998（egress API）は loopback。hls / rtmp / srt / moq と RTSP UDP transport は無効。
replica は ingress を置かないので 8189 は不要（22 / 80 / 443 / 554 のみ）。

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
- cron は ingress client で publisher を kick し、`MEDIAMTX_READ_EGRESS_API_URLS` の全 read egress で viewer / path を観測する。origin を含め、増設時はカンマ区切りで URL を追加する
- いずれかの read egress が未観測の回は `no_viewers` と `kick_pending` の解除を見送る。`stream_lifecycle_completed` の `egressObserved` / `egressUnobserved` で観測状態を確認する

## origin を別ノードへ移す（Indigo → Cherry など）

判断基準と設計上の理由は [scale-plan.md](scale-plan.md)「origin 移設（Indigo → Cherry）の手順」が正本。ここはそれをコマンド粒度に落とす。
ノード構築そのものの差分は [MediaMTX relay 運用手順](../../web/streaming/README.md)「Read replica node」を参照（ここで再説明しない）。
DNS 操作は Cloudflare ダッシュボードで行う（API token は使わない・書かない）。

### 着手前に決めること（未解決）

WHIP を 8889 へ通すのは Caddy の `webscreen.tv` ブロックだけで（`web/streaming/Caddyfile`）、Worker の `STREAM_WHIP_ORIGIN` は `https://webscreen.tv`。
**`webscreen.tv` の A レコードを 2 本にした瞬間、配信開始の WHIP も read ノードへ均等に飛び、ingress の無いノードを引いた配信が失敗する。**
A レコードを増やす前に、どちらかを決めて反映すること（この節の手順 3 の前提）:

- origin だけに解決する WHIP 用ホスト名を用意し、`STREAM_WHIP_ORIGIN` をそれに向ける（ホスト名は未決定。`stream.web-screen.net` は Control API 専用で WHIP ルートを持たない）
- replica の Caddy にも `webscreen.tv` の WHIP ルートを置き、origin へ reverse_proxy する（ノード間 1 ホップ。**未検証**）

あわせて未検証: `webscreen.tv` の A レコードが複数になると ACME の challenge（HTTP-01 / TLS-ALPN）がどのノードへ届くか決まらないため、各ノードで `webscreen.tv` の証明書を取る構成は取得・更新がリトライ頼みになる。ノード専用ホスト名（Control API 用・WHIP 用）は 1 ノードにしか解決しないのでこの問題を持たない。

### 手順

1. **新ノードを replica として構築する。** 新ノードの `ORIGINS` は現 origin。既存の replica がある場合は、その `ORIGINS` を「新 origin, 現 origin」の順に先回りで書いておくと手順 9 が掃除だけで済む（自ノードは `ORIGINS` に入れない）。
   ```sh
   ssh <new-node> 'systemctl is-active webscreen-mediamtx-egress-replica'
   ssh <new-node> 'curl -fsS http://127.0.0.1:9998/v3/paths/list | jq'
   ```
2. **Control API が外から HTTPS で届くことを確認する。** cron がここを読むので、ノード専用のホスト名と Caddy 証明書が要る（`webscreen.tv` は複数ノードに解決するため使えない。ホスト名は未決定）。token は Caddy の env ファイル経由で、egress 側は Worker と同じ role 別 token を使う。
   ```sh
   curl -si https://<新ノードの Control API ホスト>/v3/paths/list | head -3   # token 無しは 401
   ```
3. **cron の read ノード一覧に追加する。** `web/cron/wrangler.jsonc` の var `MEDIAMTX_READ_EGRESS_API_URLS` にカンマ区切りで追記する PR → main マージ → Actions デプロイ。A レコードより先に入れる（到達できるノードを足すのは無害だが、A レコードだけ先に足すと reader を数えられない）。デプロイ後は `stream_lifecycle_completed` の `egressObserved` に新ノードが載ることを「cron（毎分 lifecycle）の検証方法」の手順で確かめる。
   ```sh
   gh run list --workflow deploy.yml --limit 1
   ```
4. **`webscreen.tv` に新ノードの A レコードを追加する**（プロキシ OFF、TTL は既存と同じ 300 秒）。この時点で視聴者と転送量の 1/N が新ノードへ流れる。
   ```sh
   dig +short webscreen.tv @1.1.1.1     # 2 本返ること
   # 配信中の ID を新ノード IP 直指定で引き、pull と再配信が成立することを見る
   ffprobe -v error -rtsp_transport tcp -show_entries stream=codec_name -of default=noprint_wrappers=1 rtsp://<新ノード IP>/live/<12文字>
   ```
5. **新ノードに ingress + relay を入れて起動し、負荷試験を行う**（条件は scale-plan の手順 2）。egress は replica のまま（`runOnDemand` は publisher が居ない時だけ発火するので、relay の publish と共存する）。`mediamtx-ingress.yml` の `webrtcAdditionalHosts` は origin の IP 直書きなので**新ノードの IP に直す**。UDP 8189 の開放と、WHIP 用ホスト名の Caddy 証明書もここで揃える。
   ```sh
   ssh <new-node> 'systemctl is-active webscreen-mediamtx-ingress'
   ssh <new-node> 'curl -fsS http://127.0.0.1:9998/v3/paths/list | jq "[.items[] | {name, ready, readers: (.readers|length), bytesSent}]"'
   ssh <new-node> 'journalctl -u webscreen-mediamtx-ingress -u webscreen-mediamtx-egress-replica --since "-15 min"'
   ```
6. **現 origin の egress にも `runOnDemand` + `ORIGINS` を入れる（未検証）。** 切替後に旧 origin を引いた視聴者へ、新 origin 発の配信を届けるために要る。`mediamtx-egress.yml` と `mediamtx-egress-replica.yml` の差は `pathDefaults` の 3 キーだけなので、次を足す形になる。
   ```yaml
   # /etc/webscreen/streaming/mediamtx-egress.yml の pathDefaults（未検証）
   pathDefaults:
     overridePublisher: false
     runOnDemand: /opt/webscreen/streaming/replica-pull.sh
     runOnDemandRestart: false
     runOnDemandCloseAfter: 10s
   ```
   あわせて `replica-pull.sh` を `runOnDemand` に書いたパス（replica の yml と同じ `/opt/webscreen/streaming/replica-pull.sh`）へ置き、`/etc/webscreen/streaming/replica.env`（`ORIGINS` は新 origin、`SELF_HOSTS` は自ノード）を作る。`webscreen-mediamtx-egress.service` は `EnvironmentFile` を持たないので drop-in が要る。
   ```sh
   ssh webscreen-indigo-poc 'sudo systemctl edit webscreen-mediamtx-egress'   # [Service] EnvironmentFile=/etc/webscreen/streaming/replica.env
   ssh webscreen-indigo-poc 'sudo systemctl show -p EnvironmentFiles webscreen-mediamtx-egress'
   ```
   - `ORIGINS` に `webscreen.tv` を書かない。複数ノードに解決するため自ノードを引きうるが、`SELF_HOSTS` の self-loop guard は文字列一致しか見ない
   - 未検証の点: origin 自身の配信でも、relay が publish する前に reader が来ると自 path の `runOnDemand` が発火する（pull は失敗して非 0 終了、`runOnDemandRestart: false`）。その後のローカル publish との相互作用は確かめていない
7. **`STREAM_WHIP_ORIGIN` を新 origin へ切り替える。** `web/wrangler.jsonc` の var を変える PR → main マージ → Actions デプロイ（secret ではない）。以降の新規配信は新 origin、既存配信は旧 origin で継続する。
   ```sh
   # 反映後に配信を 1 本開始し、新 origin 側の ingress に path が立つことで確認する
   ssh <new-node> 'curl -fsS http://127.0.0.1:9997/v3/paths/list | jq "[.items[] | {name, ready}]"'
   ```
8. **旧 origin の live が 0 になるまで待つ。** 本番は延長無効・15 分固定なので**最長 15 分**。判定は旧 origin の **ingress（:9997）の path が空**になること。手順 6 を入れた後は、新 origin 発の配信を pull した egress path が旧 origin にも立つので、egress は判定に使わない。
   ```sh
   ssh webscreen-indigo-poc 'curl -fsS http://127.0.0.1:9997/v3/paths/list | jq "[.items[] | {name, ready}]"'
   cd web && bunx wrangler d1 execute webscreen-beta-db --remote -c wrangler.jsonc \
     --command "SELECT COUNT(*) AS live FROM stream_sessions WHERE status = 'live'"
   ```
   `stream_sessions` に origin 列が入るのは M3 以降なので、この件数は全 origin の合計（切替後は新 origin 発の配信も数える）。ノード単位の判定は上の ingress path を使う。
9. **read 専用 replica の `ORIGINS` を新 origin 単独へ更新する。** 掃除なので急がない。restart は pull 中の視聴を切るため、そのノードの全 path の `readers` が 0 のときに行う（確認は「read edge を撤去する」の手順 2 と同じコマンド）。新 origin 自身の `ORIGINS`（旧 origin 向き）はそのまま残す — ローカル publisher がある path では発火せず、ロールバック時にそのまま効く。
   ```sh
   ssh <replica> 'sudo systemctl restart webscreen-mediamtx-egress-replica && systemctl is-active webscreen-mediamtx-egress-replica'
   ```
10. **旧 origin は replica として残す**（ロールバック先）。ingress だけ止める。手順 6 の設定が入っているので egress はそのまま read を続けられる。
    ```sh
    ssh webscreen-indigo-poc 'sudo systemctl disable --now webscreen-mediamtx-ingress'
    ssh webscreen-indigo-poc 'systemctl is-active webscreen-mediamtx-ingress || true'
    ```

### ロールバック（逆順）

`wrangler rollback` は Worker のコードだけを戻すので、var の変更は必ず PR で戻す。

1. 旧 origin の ingress を起動する（`sudo systemctl enable --now webscreen-mediamtx-ingress` → `systemctl is-active`）
2. read 専用 replica の `ORIGINS` を「旧 origin, 新 origin」に戻して restart（WHIP を戻す前に。先に戻さないと、旧 origin 発の新規配信を pull できない replica が残る）
3. `STREAM_WHIP_ORIGIN` を旧 origin へ戻す PR → デプロイ（WHIP 用ホスト名を分けている場合は、その A レコードも旧 origin へ戻す）
4. 新 origin の **ingress** path が空になるまで待つ（手順 8 と同じ確認。最長 15 分）
5. 新ノードを畳むなら「read edge を撤去する」節の順序で外す

## read edge を足す（自宅・会社回線を含む）

read 専用ノードの追加。Worker / D1 のスキーマ変更は要らない。条件と制約の背景は [scale-plan.md](scale-plan.md)「自宅・会社回線を edge として足す条件」。

| 必要条件 | 確認 |
|---|---|
| 固定 IPv4 | `dig +short myip.opendns.com @resolver1.opendns.com` を日をおいて比較、または回線契約を確認 |
| TCP 22 / 80 / 443 / 554 の開放（UDP 8189 は不要） | 外部回線から `nc -vz <edge-ip> 554` と `nc -vz <edge-ip> 443` |
| replica 構成（README「Read replica node」） | `ssh <edge> 'systemctl is-active webscreen-mediamtx-egress-replica'` |
| Caddy + 証明書（ノード専用の Control API ホスト名。`webscreen.tv` は使えない） | `curl -si https://<edge の Control API ホスト>/v3/paths/list \| head -3` が 401 |
| cron の read ノード一覧に追加 | `web/cron/wrangler.jsonc` の `MEDIAMTX_READ_EGRESS_API_URLS` に追記する PR → デプロイ |
| `webscreen.tv` の A レコード追加（プロキシ OFF・TTL 300 秒） | `dig +short webscreen.tv @1.1.1.1` |

手順の順序は origin 移設の 1 → 2 → 3 → 4 と同じ（構築 → Control API 到達 → cron 一覧 → A レコード）。A レコードを入れた後に実際に reader が届くかを見る。

```sh
ffprobe -v error -rtsp_transport tcp -show_entries stream=codec_name -of default=noprint_wrappers=1 rtsp://<edge-ip>/live/<12文字>
ssh <edge> 'curl -fsS http://127.0.0.1:9998/v3/paths/list | jq "[.items[] | {name, ready, readers: (.readers|length)}]"'
```

制約:

- **`webscreen.tv` の A レコードを増やすと WHIP も分散する**。「着手前に決めること（未解決）」を先に解決すること
- 分散は DNS の均等のみ。細い回線でも 1/N が来るので path 単位の `maxReaders` で自衛する（値は #223）
- Control API へ HTTPS で到達できない edge を A レコードに入れると reader を数えられず、`no_viewers` が誤発火する
- 自宅・会社の IPv4 が公開 A レコードに載る
- `make stream-paths` / `make stream-logs` は origin 前提（9997 と ingress unit を見る）。replica では上の ssh + curl / `journalctl -u webscreen-mediamtx-egress-replica` を直に使う

## read edge を撤去する

1. **`webscreen.tv` の A レコードを削除する**（Cloudflare ダッシュボード）
   ```sh
   dig +short webscreen.tv @1.1.1.1     # 該当 IP が消えること
   ```
2. **TTL 300 秒 + 既存 reader が切れるまで待つ。** VRChat が滞在中に再解決するかは未確認なので、時間ではなく実測で待つ。
   ```sh
   ssh <edge> 'curl -fsS http://127.0.0.1:9998/v3/paths/list | jq "[.items[] | {name, readers: (.readers|length)}]"'
   ```
   全 path の `readers` が 0 になるまで繰り返す。
3. **cron の read ノード一覧から除外する**（`MEDIAMTX_READ_EGRESS_API_URLS` の PR → デプロイ）。先に unit を止めると未観測扱いになり、`no_viewers` と `kick_pending` の解除が見送られ続ける。
4. **unit を停止する。**
   ```sh
   ssh <edge> 'sudo systemctl disable --now webscreen-mediamtx-egress-replica'
   ssh <edge> 'systemctl is-active webscreen-mediamtx-egress-replica || true'
   ```

## 実機 E2E の作法

- ブラウザの画面ピッカーはネイティブ UI のため自動操作できない。**E2E は「人が配信開始 → AI が ffprobe / D1 / journalctl で検証」の協働型**で行う
- 検証観点: ffprobe で H.264 と、音声ありなら AAC-LC 48 kHz / stereo / 128 kbps + バックグラウンドタブで 10 分放置しても heartbeat_lost にならないこと
