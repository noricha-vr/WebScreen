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
| Cherry | **read replica + origin 機能**（構築済み 2026-09-04。replica の取り寄せは MediaMTX `source` 方式を 2026-09-05 に反映済み。`webscreen.tv` の A レコードには未登録、WHIP も未割当。計測は [verification.md](verification.md) I26 / I27） | Cherry Servers Cloud VDS 2（Chicago, US）`88.216.73.71`（SSH: `ssh webscreen-cherry`、root、Ed25519 鍵は ~/.ssh/config 参照）。ポータル名 `webscreen-chicago-01` / Resource #988436。4 vCore / 16 GB / NVMe 100 GB / 1 Gbps / 月 10 TB 込み / €29 月（次回請求 2026-10-04）。Ubuntu 24.04。ufw active（22 / 80 / 443 / 554 tcp + 8189 udp）、ポータル側 FW なし。TCP 554 の接続数上限は unit `webscreen-egress-cap`（nftables）。ノード用ホスト `chi1.web-screen.net`（Caddy = `web/streaming/Caddyfile.node`、アクセスログ有効）。relay は **Indigo 稼働中の AAC 版を複製**（`/opt/webscreen/streaming/releases/indigo-prod-aac-2026-09-04`。リポの `relay.sh` は MP3 候補なので入れない） | `webscreen-mediamtx-ingress`（`webrtcAdditionalHosts` は自 IP、WHIP 未割当）+ `webscreen-mediamtx-egress-replica`（`source` = `stream.web-screen.net`）+ `webscreen-egress-cap` |

origin ノードの中身:

| 項目 | 値 |
|---|---|
| MediaMTX | `/usr/local/bin/mediamtx`（v1.20.1）+ versioned config `/etc/webscreen/streaming` |
| relay | `/opt/webscreen/streaming/relay.sh`。映像 copy、音声があれば AAC 変換 |
| 常駐 | 旧 `mediamtx.service` と `/etc/mediamtx/mediamtx.yml` は停止済み（現行 unit は上表） |
| TLS 終端 | Caddy `/etc/caddy/Caddyfile` + `/etc/caddy/mediamtx-api.env`（ingress / egress 別 token。root:root 600） |
| ログ | journald（上記2 unit を指定。/var/log/journal で永続） |
| DNS | Cloudflare。`webscreen.tv`（apex A → **全 read ノード**の IP・**プロキシ OFF 必須**。凍結ドメイン、自動更新を切らない。TTL 300 秒）/ `stream.web-screen.net`（A → **origin の IP だけ**。origin の Control API と WHIP 用。利用者には案内しない）/ `chi1.web-screen.net`（A → Cherry。read ノードの Control API 用。cron だけが使う）。役割の整理は「ホスト名の役割」節 |

ポート方針: 公開は **22 / 80 / 443 / 554(tcp) / 8189(udp)** のみ。8889（WHIP）、8554（ingress RTSP）、
9997（ingress API）、9998（egress API）は loopback。hls / rtmp / srt / moq と RTSP UDP transport は無効。
replica は ingress を置かないので 8189 は不要（22 / 80 / 443 / 554 のみ）。

## ホスト名の役割（決定済み。この節を読んだら同じ質問をしない）

**公開 URL にサブドメインを付けない理由**（2026-09-04 ユーザー確認。ChatGPT との 2026-09-02 設計セッションで決めた判断の正本）:

`webscreen.tv` はフロントのブランド URL ではなく、**VRChat から接続する配信バックエンドの固定入口**である。
`node-01.webscreen.tv` / `stream.webscreen.tv` のように VRChat から見える接続先を分ける案は採らず、視聴 URL は常に
`rtspt://webscreen.tv/live/{id}` に固定する。理由は **VRChat ワールド側の URL 許可リストを 1 枠に抑えるため**。
ノードが増えるたびに `node-01` `node-02` … を VRChat に直接参照させる構成は、ワールドの許可設定と相性が悪い
（allowlist はホスト単位。[vrchat-constraints.md](vrchat-constraints.md)「allowlist」節、[requirements.md](requirements.md)）。

> バックエンドのノード構成を VRChat から隠し、VRChat 側で許可する接続先を `webscreen.tv` 1 つに固定したいので、公開 URL にはサブドメインを付けない。

「ブランドとして短い」「Web アプリ自体が商品だから」は別件の話で、この判断の理由ではない。
裏側の振り分けは、配信側は Worker + D1 が origin を決めて `whipUrl` で返し（[scale-plan.md](scale-plan.md) M3 で `origin_node_id`）、
視聴側は `webscreen.tv` の複数 A レコードで READY な read ノードへ分散する（同 M1）。地域別の振り分けも同じ制約の下で行う（[#228](https://github.com/noricha-vr/WebScreen/issues/228)）。
調査原文の該当箇所: [../research/2026-09-04-hosting-region-research.md](../research/2026-09-04-hosting-region-research.md)「重要な制約」（`stream.web-screen.net` をサーバーごとのホスト名へ変更してはいけない、と書かれているが指しているのは視聴 URL のホスト）。

この理由が効くのは **VRChat から見えるホストだけ**。cron や配信者ブラウザだけが使う内部ホストはノードごとに分けてよく、VRChat の許可リストには一切影響しない。

| 種類 | ホスト | 解決先 | 見る人 | なぜこの形か |
|---|---|---|---|---|
| 視聴 URL | `webscreen.tv`（凍結・変更不可） | **全 read ノード**の A レコード（DNS ラウンドロビン、プロキシ OFF、TTL 300 秒） | VRChat 利用者 | 上記の理由。ノードの増減は A レコードの追加・削除だけで行う |
| WHIP と origin の Control API、replica の取り寄せ先 | `stream.web-screen.net`（既存。プロキシ OFF 必須 — replica が TCP 554 で RTSP を引く） | **origin 1 台だけ** | 配信者ブラウザ（WHIP）、Worker（Control API）、全 replica の MediaMTX（`source`） | WHIP は ingress のある origin だけに届く必要がある。`webscreen.tv` が複数 A になると WHIP が replica に飛んで失敗するので、`STREAM_WHIP_ORIGIN` はこのホストに向ける（Caddy に WHIP ルートを追加。反映は [#219](https://github.com/noricha-vr/WebScreen/issues/219) の冗長化作業）。origin 移設はこの A レコードの向き先変更だけで済む |
| read ノードの Control API | ノード専用: `chi1.web-screen.net`（Cherry）。Indigo が replica に降りたら `tyo1.web-screen.net` | そのノード 1 台 | cron Worker のみ（`MEDIAMTX_READ_EGRESS_API_URLS`） | cron はノード単位で reader を数えるので個別に到達できるホストが要る。1 ノードにしか解決しないので ACME の証明書取得も安定する |

ノード専用ホスト名の命名は「リージョン略号 + 連番 . web-screen.net」（`chi1` / `tyo1`）。`webscreen.tv` 配下には作らない。

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
- 転送量通知（`node_egress_daily`）の検証: 通知判定は cron が実在ノードを集計した時にしか走るので、`node_key` は **実ノードの Control API の host**（例 `stream.web-screen.net`）、`day` は **JST の今日**にする。(a) `bunx wrangler d1 execute webscreen-beta-db --remote -c wrangler.jsonc --command "SELECT bytes_sent, alerted_level FROM node_egress_daily WHERE node_key = 'stream.web-screen.net' AND day = 'YYYY-MM-DD'"` で現在値を控える。(b) 行があれば `bunx wrangler d1 execute webscreen-beta-db --remote -c wrangler.jsonc --command "UPDATE node_egress_daily SET bytes_sent = bytes_sent + 112000000000, alerted_level = 0 WHERE node_key = 'stream.web-screen.net' AND day = 'YYYY-MM-DD'"`、なければ `bunx wrangler d1 execute webscreen-beta-db --remote -c wrangler.jsonc --command "INSERT INTO node_egress_daily (node_key, day, bytes_sent, alerted_level, updated_at) VALUES ('stream.web-screen.net', 'YYYY-MM-DD', 112000000000, 0, datetime('now'))"` を実行する。(c) 次の毎分 cron で Discord に `[警告] egress ...` が届くことを確認する。(d) 復元は控えた値への上書きではなく**合成分だけの減算**で行う（検証中も毎分 cron が実転送量を加算しているため）: `UPDATE node_egress_daily SET bytes_sent = bytes_sent - 112000000000, alerted_level = <控えた alerted_level（元行なしは 0）> WHERE node_key = 'stream.web-screen.net' AND day = 'YYYY-MM-DD'`。元行が無かった場合も減算後の `bytes_sent` が 0 なら DELETE、0 より大きければ残す（cron が作った正規の当日行）。sample 行は触らない。
- いずれかの read egress が未観測の回は `no_viewers` と `kick_pending` の解除を見送る。`stream_lifecycle_completed` の `egressObserved` / `egressUnobserved` で観測状態を確認する

## origin を別ノードへ移す（Indigo → Cherry など）

判断基準と設計上の理由は [scale-plan.md](scale-plan.md)「origin 移設（Indigo → Cherry）の手順」が正本。ここはそれをコマンド粒度に落とす。
ノード構築そのものの差分は [MediaMTX relay 運用手順](../../web/streaming/README.md)「Read replica node」を参照（ここで再説明しない）。
DNS 操作は Cloudflare ダッシュボードで行う（API token は使わない・書かない）。

### 着手前の前提（決定済み）

WHIP を 8889 へ通すのは Caddy の `webscreen.tv` ブロックだけで（`web/streaming/Caddyfile`）、Worker の `STREAM_WHIP_ORIGIN` は `https://webscreen.tv`。
**`webscreen.tv` の A レコードを 2 本にした瞬間、配信開始の WHIP も read ノードへ均等に飛び、ingress の無いノードを引いた配信が失敗する。**
決定（「ホスト名の役割」節）: origin だけに解決する `stream.web-screen.net` の Caddy ブロックに WHIP ルートを足し、`STREAM_WHIP_ORIGIN` を `https://stream.web-screen.net` に向ける。
**この 2 つを手順 4（A レコード追加）より先に反映する。** replica の Caddy で `webscreen.tv` の WHIP を origin へ reverse_proxy する案は採らない（1 ホップ増える上に未検証）。
`webscreen.tv` の証明書を各ノードで取る構成は ACME challenge がどのノードへ届くか決まらないので採らず、HTTPS が要るホストはすべて 1 ノードにしか解決しないノード専用ホストにする。

### 手順

1. **新ノードを replica として構築する。** 取り寄せ先は yml の `source` に書いた `stream.web-screen.net`（= 現 origin）で、ノードごとの設定値は無い。順序付きフォールバックは `source` に無いので、origin の切替は手順 9 の DNS 変更 1 箇所で行う。
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
5. **ここから先（新ノードでの ingress 起動 → WHIP 切替 → 旧 origin の replica 化）は `source` 方式では手順が成立しないため、[#252](https://github.com/noricha-vr/WebScreen/issues/252) で再設計するまで実施しない。** 成立しない理由は 2 つ:
   - `source` を持つ path は publisher を受け付けないので、egress は「replica 版（他 origin から pull できる）」か「origin 版（relay の publish を受ける）」のどちらか一方にしかできない。新ノードを origin 版へ切り替えた瞬間、そのノードを `webscreen.tv` で引いた視聴者は旧 origin 発の配信を再生できなくなる（readers が 0 の瞬間を待っても新規接続は防げない）。旧 origin を replica 版に戻す時も同じ
   - `STREAM_WHIP_ORIGIN` は `stream.web-screen.net` を指すが、そのホストは全 replica の取り寄せ先でもある。WHIP だけ先に新 origin へ向けるにはホストを分けるか、`stream.web-screen.net` を切り替えた瞬間に旧 origin 発の配信（最長 15 分）を全 replica が引けなくなることを受け入れる必要がある

   再設計の材料: 新ノードを A レコードから外した状態で origin 版に切り替えて負荷試験する（`webscreen.tv` に載っていなければ視聴者への影響は無い）/ 切替の瞬間に旧 origin を A レコードから外し TTL（300 秒）ぶん待ってから旧 origin を replica 版へ戻す / WHIP 用ホストを `stream.web-screen.net` から分離する。ロールバック手順も再設計後に書く。

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

- **`webscreen.tv` の A レコードを増やすと WHIP も分散する**。先に `STREAM_WHIP_ORIGIN` を `https://stream.web-screen.net` に向ける（「ホスト名の役割」節）
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
