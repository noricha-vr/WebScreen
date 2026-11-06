/** UI とエンコーダが共有する、1 枚あたりの表示秒数。 */
export const SECONDS_PER_FRAME_OPTIONS = [1, 2] as const;
export type SecondsPerFrame = (typeof SECONDS_PER_FRAME_OPTIONS)[number];
export const DEFAULT_SECONDS_PER_FRAME: SecondsPerFrame = SECONDS_PER_FRAME_OPTIONS[0];

export function isSecondsPerFrame(value: unknown): value is SecondsPerFrame {
  return SECONDS_PER_FRAME_OPTIONS.some((seconds) => seconds === value);
}
