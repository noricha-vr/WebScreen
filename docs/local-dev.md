# ローカル開発・E2E の環境注意

基本コマンドは [CLAUDE.md](../CLAUDE.md) の「開発」節。リポジトリ直下の GNU make を前提に、利用可能な入口は `make help` で確認する。ここには環境起因のハマりどころと復旧手順を置く。

## dev サーバー

- 常駐型。多重起動の警告が出たら `bunx astro dev stop`
- ページが vite の deps_ssr エラーを返す時は `rm -rf node_modules/.vite` してから再起動

## E2E のポートは worktree ごとに分ける

Playwright の `reuseExistingServer`（ローカルでは有効）は、**同じポートで待ち受けていれば別セッション・別 worktree のサーバーでも再利用**する。ビルドが走らないため、テストが自分の変更を含まない古いビルドに対して通る / 落ちる。

- 並行 worktree・並行セッションで E2E を回す時は **`E2E_PORT` でポートをずらす**（既定 4322。`web/playwright.config.ts`）
- **テスト全体が数秒で終わったら再利用を疑う**（ビルドもサーバー起動も走っていない印）
- 切り分けは結果ではなくプロセスを見る: `lsof -nP -iTCP:{port} -sTCP:LISTEN` → `ps -o pid,lstart,command -p {PID}` で誰がどのディレクトリから起動したか分かる
- 他人のプロセスは kill せず自分のポートをずらす。自分の残骸は wrangler の親（node プロセス）から落とす（子の workerd だけ kill しても親が再生成する）

## Claude Code サンドボックスとの相性

- **E2E（wrangler dev / Playwright webServer）はサンドボックス内 Bash では動かない**。miniflare が内部で張る接続がネットワーク遮断に当たり `read ECONNRESET` → `webServer was not able to start` で落ちる。環境変数では直らないので、その呼び出しだけサンドボックス外で実行する
- **build の EPERM** は別問題: wrangler が `~/Library/Preferences/.wrangler` 等へ書けないだけなので、`MINIFLARE_REGISTRY_PATH=/private/tmp/{name}` と `WRANGLER_LOG_PATH=/private/tmp/{name}.log`（必要なら `XDG_CONFIG_HOME` も）を指定すればサンドボックス内で通る
