# Search Console の実測と、新サイト移行で失った検索流入（2026-08-30）

Cloudflare 版へ移行した後、新サイトが検索からほとんど流入を得ていないことが分かった。その実測値と原因、対応方針を残す。

## 観測

- 取得元: Search Console API（プロパティ `sc-domain:web-screen.net`）
- 期間: 2026-05-30 〜 2026-08-27（90 日）
- 取得日: 2026-08-30

### 全体

| 指標 | 値 |
|---|---|
| クリック | 1,475 |
| 表示回数 | 26,337 |
| **新サイト（`https://`）の取り分** | **3 クリック / 160 表示（全体の 0.6%）** |

残り 99% は旧 FastAPI 版の `http://` URL が稼いでいる。日別で見ると 7/14〜8/26 のクリックは日 5〜27 で推移し、**移行後も減っていない**（8/26 が最大の 27 クリック / 378 表示）。旧 URL のインデックスがまだ生きている状態。

### ページ別（上位）

| ページ | クリック | 表示回数 | 平均順位 |
|---|---|---|---|
| `http://web-screen.net/en/streaming/` | 482 | 9,248 | 8.7 |
| `http://web-screen.net/ja/streaming/` | 195 | 4,755 | 6.7 |
| `http://web-screen.net/en/` | 277 | 3,090 | 5.9 |
| `http://web-screen.net/en/web/` | 205 | 1,786 | 6.3 |
| `http://web-screen.net/ja/image/` | 116 | 1,595 | 7.2 |
| `http://web-screen.net/ja/` | 93 | 3,547 | 8.2 |
| `http://web-screen.net/ja/web/` | 75 | 1,293 | 7.0 |

### クエリの主題別

| 主題 | 表示回数 | クリック |
|---|---|---|
| 画面共有系（`vrc 画面共有` 887 ほか） | 2,173 | 62 |
| 変換系（`vrc url 変換` ほか） | 538 | 71 |
| 録画系 | 370 | 7 |

**表示だけでクリック 0 の大物**:

| クエリ | 表示回数 | 平均順位 |
|---|---|---|
| `vrchat web` | 1,247 | 9.2 |
| `vrc web` | 344 | 9.6 |
| `vrchat 動画` | 159 | 8.1 |

いずれも 1 ページ目の最下部で、タイトルが検索意図に答えていないため選ばれていない。

## 診断

原因は「キーワードの調整不足」ではなく**受け皿ページの消失**。

旧サイトは用途別に 6 ページ（`/web/` `/image/` `/pdf/` `/recording/` `/streaming/` `/github/`）を持ち、それぞれが個別のキーワードで順位を得ていた。Cloudflare 版はこれを 1 ページに統合し、`public/_redirects` で**全部を言語トップへ 301**（多対一）した。

リダイレクト先の内容が元のページと一致しないため、Google は評価を引き継がない。特に `/en/streaming/`（9,248 表示）の受け皿が「VRChat 用の動画に変換」というトップページでは、検索意図（画面共有の方法を知りたい）に答えていない。

加えて、新サイトの文言には「画面共有」「録画」という語が一度も出てこない（旧サイトは `/streaming/` `/recording/` で持っていた）。

## 対応方針

1. 用途別ページを復活させる（`/{lang}/web/` `/{lang}/image/` `/{lang}/pdf/`）。変換パネルはトップに置いたまま、各ページは説明 + CTA にする
2. 旧 URL の 301 を 1 対 1 に向け直す。実ページができた URL はリダイレクト行ごと削除する
3. `/{lang}/screen-share/` を新設し、旧 `/streaming/` `/recording/` の受け皿にする。**リアルタイムの画面共有機能は未実装なので、誇大表示せず「画面共有の代わりに使える場面」を説明する**
4. sitemap と `tests/contracts/sitemap.test.ts` を新ページに合わせる

この観測から立てた施策の計画は [2026-08-30-internal-seo-plan.md](2026-08-30-internal-seo-plan.md) にある。

## 再測定の方法

同じ数字を取り直すには:

```bash
S=~/.claude/skills/search-console
uv run --project $S python $S/search_console.py \
  --site-url "sc-domain:web-screen.net" --dimensions query --days 90 --limit 500 --sort impressions
```

`--dimensions page` でページ別、`--dimensions date` で日別。Search Console のデータは 2〜3 日遅れる。

判定の目安: 新設ページが Google にインデックスされるまで数週間かかる。次の確認は**新ページ公開から 4〜8 週後**に、(1) `https://` の取り分が伸びているか、(2) `vrchat web` `vrc 画面共有` の順位が 9 位前後から上がっているか、の 2 点で見る。
