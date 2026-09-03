/** 現在の URL の query 部分を安全に取得する。 */
export function currentSearch(): string {
  return globalThis.window?.location?.search ?? '';
}

/** 指定時間だけ非同期で待機する。 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** 指定時刻までの秒数を0以上で返す。 */
export function durationUntil(expiresAt: string, from: number): number {
  return Math.max(0, (Date.parse(expiresAt) - from) / 1000);
}

/** 診断スナップショット用に UA を取得する（SSR・非ブラウザでは空文字）。 */
export function userAgentString(): string {
  return typeof navigator !== 'undefined' ? navigator.userAgent : '';
}

/** 共有中トラックの displaySurface（'monitor' / 'window' / 'browser' 等）。取得不能は null。 */
export function displaySurfaceOf(media: MediaStream | null): string | null {
  return media?.getVideoTracks()[0]?.getSettings?.().displaySurface ?? null;
}

/** 共有中トラックの解像度・フレームレート。診断で「送出前に映像が出ているか」を見る。 */
export function videoSettingsOf(
  media: MediaStream | null
): { width: number | undefined; height: number | undefined; frameRate: number | undefined } | null {
  const settings = media?.getVideoTracks()[0]?.getSettings?.();
  if (!settings) return null;
  return { width: settings.width, height: settings.height, frameRate: settings.frameRate };
}
