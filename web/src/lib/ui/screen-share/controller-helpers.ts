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
