import type { CreateStreamResponse } from '../../contracts/streams';
import type { WhipPublisher } from '../whip-publisher';
import { captureHandleFor, type CaptureHandle } from './capture';

export const HEARTBEAT_INTERVAL_MS = 25_000;
export const EXPIRY_WARNING_SECONDS = 5 * 60;
const CLOCK_INTERVAL_MS = 1_000;

/** 画面選択後から server ID 確定までの開始操作を所有する。 */
export class StartRun {
  readonly capture: CaptureHandle;
  readonly abortController = new AbortController();
  cancellationRequested = false;

  constructor(
    readonly generation: number,
    readonly startToken: string,
    media: MediaStream
  ) {
    this.capture = captureHandleFor(media);
  }

  cancel(): void {
    this.abortController.abort();
    this.capture.dispose();
  }
}

/** ID 確定後の publisher・token・タイマー・解放状態を一元所有する。 */
export class LiveStreamSession {
  publisher: WhipPublisher;
  publishToken: string;
  publishTokenExpiresAt: string;
  extendExpiresAt: string;
  private localReleased = false;
  private serverStopRequested = false;
  private whipDeleteRequested = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;

  readonly id: string;
  readonly streamUrl: string;
  readonly whipUrl: string;
  readonly startedAt: string;
  readonly capture: CaptureHandle;
  readonly abortController: AbortController;

  constructor(created: CreateStreamResponse, publisher: WhipPublisher, run: StartRun) {
    this.id = created.id;
    this.streamUrl = created.streamUrl;
    this.whipUrl = created.whipUrl;
    this.startedAt = created.startedAt;
    this.publishToken = created.publishToken;
    this.publishTokenExpiresAt = created.publishTokenExpiresAt;
    this.extendExpiresAt = created.extendExpiresAt;
    this.publisher = publisher;
    this.capture = run.capture;
    this.abortController = run.abortController;
  }

  startTimers(heartbeat: () => void, clock: () => void): void {
    this.clearTimers();
    clock();
    this.heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
    this.clockTimer = setInterval(clock, CLOCK_INTERVAL_MS);
  }

  clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.heartbeatTimer = null;
    this.clockTimer = null;
  }

  closeLocal(): void {
    if (this.localReleased) return;
    this.localReleased = true;
    this.clearTimers();
    this.capture.dispose();
    this.publisher.close();
  }

  claimServerStop(): boolean {
    if (this.serverStopRequested) return false;
    this.serverStopRequested = true;
    return true;
  }

  claimWhipDelete(): boolean {
    if (this.whipDeleteRequested) return false;
    this.whipDeleteRequested = true;
    return true;
  }
}

/** ISO8601 の期限まで残る秒数を表示用の非負整数で返す。 */
export function secondsUntil(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

/** 延長期限の警告を出す残り時間かを判定する。 */
export function isExpiryWarning(expiresAt: string, now = Date.now()): boolean {
  return secondsUntil(expiresAt, now) <= EXPIRY_WARNING_SECONDS;
}

/** タイマー・画面共有・PeerConnection をこの順に同期解放する。 */
export function releaseScreenShare(
  live: Pick<LiveStreamSession, 'publisher'> & { media?: MediaStream; capture?: CaptureHandle },
  clearTimers: () => void
): void {
  clearTimers();
  if (live.capture) live.capture.dispose();
  else if (live.media) captureHandleFor(live.media).dispose();
  live.publisher.close();
}

/** current ではない publisher のローカル・リモート資源を破棄する。 */
export async function releasePublisher(publisher: WhipPublisher): Promise<void> {
  publisher.close();
  await publisher.deleteResource().catch((error) => {
    console.warn('Failed to delete WHIP resource', error);
  });
}
