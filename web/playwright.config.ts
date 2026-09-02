import { defineConfig, devices } from '@playwright/test';

/**
 * e2e 用ポート。astro dev の既定（4321）を避け、開発者が dev サーバーを
 * 動かしたままでもテストが衝突しないようにする。
 *
 * 並行 worktree でも e2e を回すため E2E_PORT で上書きできる。同じポートを別の
 * worktree が握っていると reuseExistingServer が「他人のビルド」に接続してしまい、
 * 自分の変更を検証したつもりで通ってしまう。
 */
const PORT = Number(process.env['E2E_PORT'] ?? 4322);
const INSPECTOR_PORT = PORT + 5000;

/** ローカル D1 / R2 の永続先。wrangler の既定値に依存せず、seed と dev で同じ場所を指す。 */
const STATE_DIR = '.wrangler/state';

/** e2e 用の署名鍵。テストが本人のセッション Cookie を自前で作れるようにする（本番の値ではない）。 */
export const E2E_SESSION_SIGNING_KEY = 'e2e-session-signing-key';

/** e2e が投入するフィクスチャ（e2e/fixtures/seed.sql と一致させること）。 */
export const E2E_FIXTURES = {
  ownerId: 1,
  readyShortId: 'E2EReady0001',
  readyFilename: 'slides.pdf',
  /** seed.sql が now + 15 日で入れるため、表示は「あと 15 日」で安定する。 */
  readyRemainingDays: 15,
  pinnedShortId: 'E2EPinned001',
  pinnedFilename: 'pinned-clip.mp4',
  /** seed.sql が now + 365 日で入れるため、pin 中の表示は「あと 365 日」で安定する。 */
  pinnedRemainingDays: 365,
  /** 3 日前に作られているので、pin を外すと作成 + 30 日 = あと 27 日に戻る。 */
  pinnedRemainingDaysAfterUnpin: 27,
  /** リネーム専用。E2EReady0001 を書き換えると公開プレビューの期待値が崩れるため分けている。 */
  renamableShortId: 'E2ERename001',
  /** pin 解除専用。E2EPinned001 の pin を外すと残日数を見る他の spec が崩れるため分けている。 */
  unpinnableShortId: 'E2EUnpin0001',
  /** seed.sql が 1 日前の期限で入れる。pin が 410 で断られることの確認に使う。 */
  expiredShortId: 'E2EExpired01',
  pendingShortId: 'E2EPending01',
  deletableShortId: 'E2EDelete001',
} as const;

const seedCommand = [
  // 毎回まっさらな D1 から作り直す（前回の pin 解除・削除が残っていると結果が変わるため）。
  `rm -rf ${STATE_DIR}`,
  'bun run build',
  // migrations/ を全部当てる（ファイル名を列挙すると新しい migration の追従漏れが起きる）。
  `bunx wrangler d1 migrations apply webscreen-beta-db --local -c wrangler.jsonc --persist-to ${STATE_DIR}`,
  `bunx wrangler d1 execute webscreen-beta-db --local -c wrangler.jsonc --persist-to ${STATE_DIR} --file=e2e/fixtures/seed.sql`,
  // ダウンロード経路は R2 の実体を読むため、seed した行に対応するオブジェクトも置く。
  `bunx wrangler r2 object put webscreen/movies/${E2E_FIXTURES.readyShortId}.mp4 --local -c wrangler.jsonc --persist-to ${STATE_DIR} --file=e2e/fixtures/sample.mp4 --content-type=video/mp4`,
  `bunx wrangler dev -c dist/server/wrangler.json --persist-to ${STATE_DIR} --port ${PORT} --inspector-port ${INSPECTOR_PORT} --var SESSION_SIGNING_KEY:${E2E_SESSION_SIGNING_KEY}`,
].join(' && ');

export default defineConfig({
  testDir: './e2e',
  // 契約の検証はユニットテスト（bun test tests）が担当し、e2e は画面の疎通だけを見る。
  fullyParallel: true,
  // FFmpeg.wasm を読み込むブラウザ E2E はメモリ・Mach ポート使用量が大きいため直列で実行する。
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [['list']],
  use: {
    // trailingSlash: 'always' なのでテスト側の URL も末尾スラッシュを付ける。
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // astro dev ではなくビルド済み Worker を wrangler dev で動かす。理由は 2 つ:
    //   1. astro dev はエージェント実行環境を検知して自動でバックグラウンド化するため、
    //      Playwright の webServer（前面プロセスの生存で待つ）と噛み合わない
    //   2. COOP/COEP は middleware と public/_headers の二重化で配っており、
    //      両方が効いているかは Worker 経由でしか確認できない
    // ビルド後にマイグレーションとフィクスチャを流し込むのは、プレビューページが
    // D1 の実データを描画するため（起動順に依存させないよう 1 本のコマンドに繋ぐ）。
    command: seedCommand,
    url: `http://localhost:${PORT}/api/health/`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});
