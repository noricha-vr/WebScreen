import { join } from 'node:path';

// `*.spec.ts` に置くと testMatch に拾われてテストが二重登録されるため、
// 共有ヘルパーは spec ではないファイル名にしている。
const SCREENSHOT_DIR = join(process.cwd(), '..', 'docs', 'tmp', 'screenshots');

/** スクリーンショットの保存先を作る（PR に貼る画面確認用。Git 管理はしない）。 */
export function screenshotPath(name: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  return join(SCREENSHOT_DIR, `${name}-${stamp}.png`);
}
