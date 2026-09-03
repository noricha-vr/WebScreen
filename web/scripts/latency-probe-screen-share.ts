import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ScreenSharePageOptions { videoProfile: 'quality' | 'realtime'; maxBitrate: number | null; streamId: string | null }

/** 画質プロファイルごとに本番画面共有ページのURLを組み立てる。 */
export function screenShareUrl(options: ScreenSharePageOptions): string {
  const url = new URL('https://web-screen.net/ja/screen-share/');
  if (options.videoProfile === 'realtime') {
    url.searchParams.set('video-profile', 'realtime');
    url.searchParams.set('video-max-bitrate', String(options.maxBitrate));
  }
  if (options.streamId) url.searchParams.set('stream-id', options.streamId);
  return url.href;
}

/** 画面共有を停止し、停止要求の完了を待ってからブラウザを閉じられるようにする。 */
export async function stopSharingBeforeClose(browser: import('@playwright/test').BrowserContext, outDir: string): Promise<void> {
  const errors: string[] = [];
  for (const page of browser.pages()) {
    const stop = page.locator('[data-screen-stop]');
    try {
      if (!(await stop.isVisible())) continue;
      // click前に待受を始め、直後のbrowser.closeでstop API / WHIP DELETEを打ち切らない。
      const stopped = page.waitForResponse((response) => response.url().includes('/api/streams/') && response.url().includes('/stop/') && response.status() >= 200 && response.status() < 300, { timeout: 10_000 });
      // click失敗時も待受の拒否を未処理にしない。click自体の失敗は下のcatchで必ず記録する。
      void stopped.catch(() => undefined);
      await stop.click({ timeout: 3_000 });
      await Promise.all([
        stopped,
        page.waitForFunction(() => { const live = document.querySelector<HTMLElement>('[data-screen-step="live"]'); return !live || live.hidden; }, undefined, { timeout: 5_000 }),
      ]);
    } catch (error) {
      const reason = `screen-share stop cleanup failed: ${errorMessage(error)}`;
      errors.push(reason);
      console.warn(reason);
    }
  }
  if (errors.length) {
    try { await writeFile(join(outDir, 'cleanup-error.md'), `${errors.join('\n')}\n`); }
    catch (error) { console.warn(`cleanup-error.md write failed: ${errorMessage(error)}`); }
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
