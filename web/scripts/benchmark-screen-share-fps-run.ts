import {
  diffVideoStats,
  snapshotPrimaryVideoStats,
  type StatsRow,
  type VideoStatsInterval,
} from './benchmark-screen-share-fps-core';

/** ブラウザから返す未集計の1計測分。 */
export interface BrowserRunRaw {
  requestedFps: number;
  durationSeconds: number;
  elapsedMs: number;
  captureFrames: number;
  trackSettings: Record<string, unknown>;
  baselineStats: StatsRow[];
  endStats: StatsRow[];
  keyframeRequests: { attempted: number; succeeded: number; error: string | null };
}

/** 製品と揃えるcaptureのideal解像度。 */
export interface CaptureIdeal {
  width: number;
  height: number;
}

/** capture deliveryとH.264送出を分離した1計測分。 */
export interface BenchmarkRunResult {
  requestedFps: number;
  durationSeconds: number;
  elapsedMs: number;
  capture: {
    requestedWidthIdeal: number;
    requestedHeightIdeal: number;
    trackSettings: Record<string, unknown>;
    deliveredFrames: number;
    deliveryFramesPerSecond: number;
  };
  h264Encode: VideoStatsInterval;
  keyframeRequests: BrowserRunRaw['keyframeRequests'];
}

/** deadline用timerをテスト可能な境界へ閉じ込める。 */
export interface DeadlineTimers {
  schedule(callback: () => void, milliseconds: number): unknown;
  cancel(handle: unknown): void;
}

const SYSTEM_TIMERS: DeadlineTimers = {
  schedule: (callback, milliseconds) => setTimeout(callback, milliseconds),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** 計測時間と猶予を超えたrunを拒否し、deadline timerを必ず解除する。 */
export async function withRunDeadline<T>(
  promise: Promise<T>,
  durationSeconds: number,
  graceMilliseconds = 30_000,
  timers: DeadlineTimers = SYSTEM_TIMERS
): Promise<T> {
  const timeoutMilliseconds = durationSeconds * 1_000 + graceMilliseconds;
  if (!Number.isFinite(timeoutMilliseconds) || timeoutMilliseconds < 0) {
    throw new Error('run deadline must be non-negative');
  }
  let handle: unknown;
  const deadline = new Promise<never>((_, reject) => {
    handle = timers.schedule(
      () => reject(new Error('measurement exceeded its deadline')),
      timeoutMilliseconds
    );
  });
  return Promise.race([promise, deadline]).finally(() => timers.cancel(handle));
}

/** raw計測からcapture deliveryとH.264区間統計を別指標として集計する。 */
export function finalizeRun(raw: BrowserRunRaw, ideal: CaptureIdeal): BenchmarkRunResult {
  const h264Encode = diffVideoStats(
    snapshotPrimaryVideoStats(raw.baselineStats),
    snapshotPrimaryVideoStats(raw.endStats),
    raw.elapsedMs
  );
  return {
    requestedFps: raw.requestedFps,
    durationSeconds: raw.durationSeconds,
    elapsedMs: raw.elapsedMs,
    capture: {
      requestedWidthIdeal: ideal.width,
      requestedHeightIdeal: ideal.height,
      trackSettings: raw.trackSettings,
      deliveredFrames: raw.captureFrames,
      deliveryFramesPerSecond: raw.captureFrames / (raw.elapsedMs / 1_000),
    },
    h264Encode,
    keyframeRequests: raw.keyframeRequests,
  };
}
