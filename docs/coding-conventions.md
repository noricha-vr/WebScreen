# 実装コンベンション

レビューの往復で確立した、このリポ固有の書き方の規約。API の契約は [`web/src/lib/contracts/api.ts`](../web/src/lib/contracts/api.ts)、R2 の配信設計は [r2-delivery.md](r2-delivery.md) が正本で、ここには「同じ指摘を二度受けないための書き方」だけを置く。

## D1 の条件付き更新

期限・容量・件数上限など「条件を満たす時だけ書き込む」処理は、**事前 SELECT で判定してから無条件に書き込む形にしない**。判定と書き込みの間に条件が変わる（保持期間バッチとユーザー操作が同じ行を触るため、実際に競合が再現している）。

- 条件は UPDATE / INSERT の **WHERE に集約**し、`meta.changes === 0` で拒否を判定する。容量予約は `INSERT ... SELECT ... WHERE` の 0 行判定で行う
- 時刻の条件は **`datetime('now')`（DB の実行時刻）で評価**する。アプリ側で取った `now` をバインドすると、バインド時刻と実行時刻の間の窓が残る（実 SQL で再現済み）
- **更新 0 件を必ず分岐**する。0 件を成功として返すと、画面は成功なのに実体が変わらない。0 件の理由は複数ある（期限切れ / 行が消えた / 上限超過）ので、その稀な経路でだけ読み直して 4xx を出し分ける
- 事前 SELECT は消さなくてよいが、役割は「エラー理由の優先順位付け」であって競合防止ではない。競合を防ぐのは WHERE の方だと分けて書く

テストの注意: フェイク DB は SQL の中身を見ないと回帰を検出できない（`datetime('now')` をバインド値に戻しても緑のまま）。時刻またぎのテストは `expires_at` を書き換えるのではなく DB 側の時計を進める形にし、直したら一度実装を戻してテストが落ちることを確認する。並行系は bun:sqlite に実 migration を適用した薄型 adapter + await barrier で「片方だけ通る」を固定する。

## R2 の条件付き操作

- `R2GetOptions.onlyIf` に渡す etag は**引用符なしの `R2Object.etag`**。引用符付きの `httpEtag` を渡すと実行時に `TypeError: Conditional ETag should not be wrapped in quotes` で落ちる（公式ドキュメントに引用符の扱いの記載はない）

| フィールド | 形 | 用途 |
|---|---|---|
| `etag` | 引用符なし | `onlyIf.etagMatches` / `etagDoesNotMatch` |
| `httpEtag` | 引用符付き | 応答の `ETag` ヘッダー / `If-Range`・`If-Match` との比較 |

- Range 要求は先に `head()` で総量を取り、満たせる `{offset, length}` だけを `range` に渡す（開始位置が総量を超えた場合の挙動は未規定で、miniflare と本番で揃わない。416 の `Content-Range: bytes */{size}` にも総量が要る）
- Astro のエンドポイントは **`HEAD` を明示 export** する。しないと GET が呼ばれて本文だけ捨てられ、Range 対応を入れると HEAD + Range が 206 になる（RFC 9110 は GET 以外の Range を無視させる）
- 公開キーへの put を create-only（`etagDoesNotMatch: '*'`）にする規約は [r2-delivery.md](r2-delivery.md) が正本

## Workers 間通信

同一アカウントでも、Worker から別 Worker の **public URL（workers.dev / カスタムドメイン）への `fetch()` は error 1042 で届かない**（相手側にリクエスト自体が来ない）。Worker 同士をつなぐなら Service Bindings（`env.BINDING.fetch()`）、外部サービス前提の実装に差し込むなら相手を Cloudflare 外のホストに置く。

## Astro SSG と時刻

静的生成のテンプレートで評価した `new Date()` は**ビルド時刻で固定**され、デプロイし直すまで変わらない。期限・時刻の判定をテンプレートに書かない。

- 期限は `data-*` 属性でテンプレートから渡し、判定は**クライアント側 JS** で行う（境界は UTC）
- JS 無効環境では消えないため、期限を過ぎたらコードごと削除する運用とセットにする（削除タスクを Issue 化）
- リクエストヘッダー（`Accept-Language` 等）が要るルートだけ `export const prerender = false` にする
