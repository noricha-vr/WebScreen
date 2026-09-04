# 配信サーバーの複数ノード化と急負荷耐性

2026-09-03 の設計判断。1 台の Indigo で動いている配信面（[operations.md](operations.md)）を、
急なアクセス増に耐えながら台数比例で増やせる形にする。数値の根拠は [capacity.md](capacity.md)。

## 決定

| 項目 | 決定 | 理由 |
|---|---|---|
| ノードの単位 | **origin 1 台 + read replica N 台** | 移すのが難しいのは WHIP を受ける origin だけ。replica は「MediaMTX + origin の URL + A レコード」で増減できる |
| 視聴 URL | `rtspt://webscreen.tv/live/{id}` 固定のまま、A レコードを全 read ノードに張る | VRChat allowlist の制約（[requirements.md](requirements.md)）。ノード別サブドメインは作らない |
| WHIP 先 | 配信開始 API の `whipUrl`（Worker env `STREAM_WHIP_ORIGIN` 由来）。Worker で proxy しない | allowlist は視聴 URL にしか効かない。proxy は Worker ホップと `Location` 書き換えが純粋なコスト |
| replica の取得 | egress path の MediaMTX ネイティブ `source` + `sourceOnDemand`。origin の **egress**（AAC 変換済み）を `stream.web-screen.net` 経由で pull | Worker / D1 に依存しない。ffmpeg 取り寄せ（`runOnDemand`）はホップごとにフレーム間隔 1 つ分の遅延を足すため不採用（[verification.md](verification.md) I27）。順序付きフォールバックは無く、origin は DNS で 1 つに決まる |
| 上限到達時の縮退 | **超過分を接続拒否**（egress path の `maxReaders`） | 制御面が全滅してもノード単体で守れる唯一の線。「全員が途切れる」より「超過分が拒否」 |
| 常時ヘッドルーム | **2 台常設**（Indigo origin 1 + replica 1、+3,410 円/月） | autoscale は VM 作成 + bootstrap + DNS TTL 300 秒で分単位。バズの立ち上がりには間に合わない |
| 上位ティア | **Cherry Servers Chicago Cloud VDS 2**（1 Gbps・月 10 TB 込み・€0.50/TB で買い足し・€29/月。2026-09-04 契約、[region-and-traffic-plan.md](region-and-traffic-plan.md)）。まず replica、VRChat 実機で遅延を確認してから origin を移す。東京 bare metal（€237/月）案は却下表へ | Indigo の 160 GB/日 は 40 人ワールド 1 つで約 6.4 時間。Cherry は転送枠をプロジェクト単位で買い足せるので転送量の壁が事実上消える |
| 自宅・会社回線 | read edge として足せる（origin にはしない） | Worker / D1 変更なしで追加・撤去できる。一時的なしのぎ・コスト削減用 |

## 構成

```
配信者ブラウザ ── WHIP (whipUrl) ──▶ origin（ingress → relay → egress）
                                          │ rtsp pull（配信ごとに 1 本、sourceOnDemand）
                        ┌─────────────────┼─────────────────┐
                        ▼                 ▼                 ▼
                   replica A         origin egress      replica B（自宅回線でも可）
                        ▲                 ▲                 ▲
                        └── webscreen.tv の複数 A レコード（均等分散）──┘
                                          ▲ rtspt
                                       VRChat
```

制約として押さえること:

- **視聴者の分散は DNS ラウンドロビンの均等のみ**。重み付け・容量比例の振り分けはホスト名固定の制約上できない。D1 の配置は publisher / origin にしか効かない
- `maxReaders` は **path 単位**の上限（1 本の配信がバズるケースに効く）。20 配信がそれぞれ上限未満でもノード帯域は超えうるので、M2 では **ノード全体の上限**（TCP 554 の同時接続数を nftables の `ct count` で制限）も同時に入れる。両方揃って初めて自衛になる
- A レコードの TTL は 300 秒（2026-09-03 実測）。VRChat が滞在中に再解決するかは未確認なので、ノード撤去は reader 0 を実測で待つ

## 段階

| 段 | 内容 | 急負荷への効き | 追跡 |
|---|---|---|---|
| M1 | replica 1 台（`source` + `sourceOnDemand`）+ cron の複数 egress 集計 + `whipUrl` 契約 + A レコード 2 本 + runbook | viewer 容量・転送量が 2 倍。origin 移設の準備が整う | milestone「配信サーバーを origin 1 + replica 1 の 2 台構成にする」（#219 #220 #221 #222 #224） |
| M2 | egress `maxReaders`（path 単位）+ TCP 554 の同時接続数上限（ノード単位）+ 転送量 160 GB/日 の日次監視と通知 | Worker / D1 / cron 全滅でも自衛できる | #223 |
| M3 | D1 `media_nodes`（provider 列）+ `stream_sessions.origin_node_id` + 配置を既存の条件付き INSERT に統合 + `node_lost` end_reason + 容量不足の専用 error code | origin 2 台以上。origin 死でも新規配信可 | M1 の実機ゲート後に milestone 化 |
| M4 | `node_scale_actions` Outbox + Provisioner（provider ごとのアダプタ）+ draining + DNS 自動更新 | 翌時間帯への備え | M3 の後 |

原案では D1 のノード概念と WHIP 振り分けを先にしていたが、律速は出口帯域と転送量で publisher は自己制限的
（人が画面共有する分しか増えず、全体 20 配信の安全弁もある）ため、origin が 2 台になるまで耐性が増えない。
先に効く read 側の分散を M1 にした。

## origin 移設（Indigo → Cherry）の手順

1. Cherry を replica として A レコードに追加。この時点で視聴者の 1/N と転送量が Cherry へ流れる
2. **これ以降（Cherry での ingress 起動 → WHIP 切替 → Indigo の replica 化）は `source` 方式では成立しない（[#252](https://github.com/noricha-vr/WebScreen/issues/252) で再設計）。** `source` を持つ path は publisher を受け付けないので egress は replica 版か origin 版のどちらか一方で、A レコードに載ったノードを origin 版へ切り替えると旧 origin 発の配信をそのノード経由で再生できなくなる。加えて `stream.web-screen.net` は WHIP 先と全 replica の取り寄せ先を兼ねるため、切替の瞬間に旧 origin 発の配信（最長 15 分）を replica が引けなくなる。手順の再設計と負荷試験（600 Mbps 連続 72 時間・reader 800 本・WHIP 20 本・UDP 8189。A レコードから外した状態で行う）は #252 の完了条件に含める

移す判断基準（案）: 転送量の 7 日移動平均が 160 GB/日 の 70% 超。値は運用で確定する。
publish JWT は Worker が署名するので origin が変わっても鍵は同じ。コマンド粒度の runbook は #224 で operations.md に置く。

## 自宅・会社回線を edge として足す条件

- 必要: 固定 IPv4、TCP 554 の開放、**TCP 80/443 の開放 + Caddy + 証明書**（cron が Control API を HTTPS で読むため。到達できない edge を A レコードに入れると reader を数えられず `no_viewers` が誤発火する）、replica 設定、`webscreen.tv` への A レコード追加、cron の read ノード一覧への追加。ingress を置かないので UDP 8189 は不要
- 制約: A レコードに入れた瞬間に他ノードと均等に視聴者が来る。回線が細くても 1/N を受けるので `maxReaders` で自衛する。自宅 IP が公開 A レコードに載る
- 撤去: A レコード削除 → TTL + 既存 reader が切れるまで待つ → cron 一覧から除外 → 停止

## M3 で変わる契約（`web/src/lib/contracts/api.ts`）

- `STREAM_END_REASONS` に `node_lost`（D1 CHECK は「追加 → 切替 → 削除」の 3 段階）
- 容量不足の専用 error code（例 `streamNoAvailableNode`、503）。READY ノード 0 件で現行の `Stream reservation was rejected unexpectedly`（500）に落ちるのを防ぐ
- ノード配置の health 鮮度条件は緩める（cron 不発で新規配信が全停止する fail-closed を作らない。cron の不発は [operations.md](operations.md) に前例あり）
- Control API token は role 別（ingress / egress）の共有 token。ノードが動的だと per-node secret を Worker で持てない
- Provisioner の順序は「作成 → IP 取得 → control 用 A レコード → bootstrap → Caddy → 外形監視 → ready → `webscreen.tv` A 追加」（Caddy の証明書取得が control 用 A レコードに依存する）

## 却下した案

| 案 | 理由 |
|---|---|
| WHIP を Astro Worker で proxy | allowlist は視聴 URL にしか効かない。ノード IP 秘匿もレート制限も現時点で要件にない |
| 最初から多 origin + 動的 resolver | origin 2 台以上になるまで耐性が増えない。律速に効かない |
| autoscale で急負荷に耐える | 分単位のリードタイムと Indigo の作成上限。ヘッドルーム + 縮退が主、autoscale は従 |
| 超過を容認して throttle リスクを取る | NTTPC の速度制限で全員が途切れる。事前申告の返答が来るまで採らない |
| 画質段の自動降格 | 実装が重く、途中で画質が変わる。M3 以降の追加候補 |
| ChatGPT 案の「1 配信 60 Mbps 予約で edge を選ぶ」 | 視聴者の行き先は DNS が決めるため、予約は origin にしか効かない |
| Cherry Cloud VPS | 1 Gbps・1 TB/月で Indigo 8GB（4.8 TB/月相当）より少ない。bare metal 一択 |
| Cherry 東京 bare metal（€237/月） | Chicago Cloud VDS 2 が 1/8 の費用で同じ 1 Gbps。転送枠は後から買い足せるので大箱を先に買う理由がない。日本向け RTT の差は実機 A/B で判断（2026-09-04） |
| 配置専用 Durable Object / 配信中 origin のライブマイグレーション | D1 の順次処理で足りる / WebRTC 再接続が要り初期に作らない |

## 未確認

- VRChat PC / Quest が複数 A レコードをどう選ぶか（先頭固定・ランダム・失敗時に次を試すか）。**M1 の実機ゲート**
- Cherry Chicago を origin にした時の VRChat 実機遅延（自宅 Mac からの ping は 184 ms）と、500 / 700 viewer・pps の負荷試験（[region-and-traffic-plan.md](region-and-traffic-plan.md)「未確定・要検証」）
- Indigo ノード間の RTSP pull の帯域・遅延増分、内部ネットワークの有無
- `maxReaders` 拒否が VRChat 側でどう見えるか
- Indigo の日次インスタンス作成上限の具体数
