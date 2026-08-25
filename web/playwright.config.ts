import { defineConfig, devices } from '@playwright/test';

/**
 * e2e 用ポート。astro dev の既定（4321）を避け、開発者が dev サーバーを
 * 動かしたままでもテストが衝突しないようにする。
 */
const PORT = 4322;

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
    command: 'bun run build && wrangler dev -c dist/server/wrangler.json --port 4322',
    url: `http://localhost:${PORT}/api/health/`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
