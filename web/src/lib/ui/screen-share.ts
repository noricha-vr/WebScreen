import {
  ERROR_CODES,
  type CreateStreamResponse,
  type ExtendStreamResponse,
  type StopLiveStreamsResponse,
} from '../contracts/api';
import { copyToClipboard } from './clipboard';
import { isUnauthorizedRequestError, JsonRequestError, requestJson } from './request-json';
import { waitForStreamReady } from './stream-health';
import {
  configureCaptureAudioTracks,
  displayAudioConstraint,
  resolveAudioProfileForSearch,
  type AudioProfile,
} from './audio-profile';
import { keyframeRequestIntervalForSearch } from './stream-profile';
import {
  SCREEN_SHARE_VIDEO_SETTINGS,
  startWhipPublisher,
  WhipPublishError,
  type WhipPublisher,
} from './whip-publisher';

export const HEARTBEAT_INTERVAL_MS = 25_000;
export const EXPIRY_WARNING_SECONDS = 5 * 60;

type ScreenSharePhase = 'idle' | 'login' | 'url' | 'live' | 'error';
type CaptureHandle = {
  readonly media: MediaStream;
  dispose: () => void;
};
type StartRun = {
  readonly generation: number;
  readonly capture: CaptureHandle;
  readonly abortController: AbortController;
};
type LiveStreamLifecycle = {
  localReleased: boolean;
  serverStopRequested: boolean;
  whipDeleteRequested: boolean;
};
type LiveStream = CreateStreamResponse & {
  publisher: WhipPublisher;
  media: MediaStream;
  capture: CaptureHandle;
  abortController: AbortController;
  lifecycle: LiveStreamLifecycle;
};
type StartedStream = { live: LiveStream; ready: boolean };

class StreamHealthError extends Error {}

/** DOM controller の外部境界。テストでは画面・API・WHIP を独立して差し替える。 */
export interface ScreenShareDependencies {
  requestJson: typeof requestJson;
  startWhipPublisher: typeof startWhipPublisher;
  waitForStreamReady: (streamId: string, signal?: AbortSignal) => Promise<boolean>;
  getDisplayMedia: typeof navigator.mediaDevices.getDisplayMedia;
  delay?: (ms: number) => Promise<void>;
  now: () => number;
  sendBeacon: (url: string) => boolean;
  onPageHide: (handler: () => void) => void;
}

const DEFAULT_DEPENDENCIES: ScreenShareDependencies = {
  requestJson,
  startWhipPublisher,
  waitForStreamReady: (streamId, signal) => waitForStreamReady(streamId, requestJson, undefined, signal),
  getDisplayMedia: (constraints) => navigator.mediaDevices.getDisplayMedia(constraints),
  delay: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
  now: () => Date.now(),
  sendBeacon: (url) => navigator.sendBeacon(url),
  onPageHide: (handler) => window.addEventListener('pagehide', handler),
};

/** タイマー・画面共有・PeerConnection をこの順に同期で解放する。 */
export function releaseScreenShare(
  live: Pick<LiveStream, 'publisher' | 'media'>,
  clearTimers: () => void
): void {
  clearTimers();
  createCaptureHandle(live.media).dispose();
  live.publisher.close();
}

/** ISO8601 の期限まで残る秒数を、表示に使える非負整数で返す。 */
export function secondsUntil(expiresAt: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000));
}

/** 延長期限の警告を出す残り時間かを判定する。 */
export function isExpiryWarning(expiresAt: string, now = Date.now()): boolean {
  return secondsUntil(expiresAt, now) <= EXPIRY_WARNING_SECONDS;
}

/** 配信開始後に URL 確認カードを経由してライブ画面へ進む順番を返す。 */
export function nextStreamStep(phase: 'url' | 'live'): 'live' | null {
  return phase === 'url' ? 'live' : null;
}

/** 画面共有カードへイベントと配信状態を配線する。 */
export function mountScreenSharePage(root: HTMLElement): void {
  new ScreenShareController(root).mount();
}

export class ScreenShareController {
  private live: LiveStream | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private phase: ScreenSharePhase = 'idle';
  private stopping = false;
  private startGeneration = 0;
  private startReservation: number | null = null;
  private activeStart: StartRun | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly deps: ScreenShareDependencies = DEFAULT_DEPENDENCIES
  ) {}

  mount(): void {
    // getDisplayMedia はクリック起点でのみ許可されるため、開始ボタンから直接呼ぶ。
    this.button('[data-screen-start]')?.addEventListener('click', () => void this.selectScreen());
    this.button('[data-screen-copy]')?.addEventListener('click', () => void this.copyUrl());
    this.button('[data-screen-show-live]')?.addEventListener('click', () => this.show(nextStreamStep('url') ?? 'live'));
    this.button('[data-screen-extend]')?.addEventListener('click', () => void this.extend());
    this.button('[data-screen-stop]')?.addEventListener('click', () => void this.stop());
    this.button('[data-screen-retry]')?.addEventListener('click', () => void this.retry());
    this.button('[data-screen-stop-others]')?.addEventListener('click', () => void this.stopOthersAndStart());
    this.deps.onPageHide(() => this.stopForPageHide());
    this.show('idle');
  }

  private async selectScreen(): Promise<void> {
    const generation = this.reserveStart();
    if (generation === null) return;
    let run: StartRun | null = null;
    this.setBusy('[data-screen-start]', true, 'labelSelecting');
    // 再試行ボタンからも入るため連打でピッカーが競合しないよう無効化する
    // （span なし構造なのでラベルは触らずアイコンを保つ）
    const retry = this.button('[data-screen-retry]');
    if (retry) retry.disabled = true;
    try {
      const profile = currentAudioProfile();
      const media = await this.deps.getDisplayMedia(displayMediaConstraints(profile));
      run = this.registerStart(media, generation);
      if (!run) return;
      configureCaptureAudioTracks(media, profile);
      await this.continueStart(run);
    } catch (error) {
      if (run) this.cancelStart(run);
      if (this.isActiveStart(generation)) this.handleStartError(error);
    } finally {
      if (run && this.activeStart === run) this.activeStart = null;
      this.releaseStartReservation(generation);
      this.setBusy('[data-screen-start]', false, 'labelStart');
      if (retry) retry.disabled = false;
    }
  }

  private async stopOthersAndStart(): Promise<void> {
    const generation = this.reserveStart();
    if (generation === null) return;
    let run: StartRun | null = null;
    this.setBusy('[data-screen-stop-others]', true, 'labelStopOthers');
    const retry = this.button('[data-screen-retry]');
    if (retry) retry.disabled = true;
    try {
      const profile = currentAudioProfile();
      const media = await this.deps.getDisplayMedia(displayMediaConstraints(profile));
      run = this.registerStart(media, generation);
      if (!run) return;
      configureCaptureAudioTracks(run.capture.media, profile);
      const stopped = asStopLiveStreams(
        await this.deps.requestJson('/api/streams/stop-live/', {
          method: 'POST',
          signal: run.abortController.signal,
        })
      );
      if (!this.isActiveRun(run)) {
        this.cancelStart(run);
        return;
      }
      this.text('[data-screen-error-message]', this.message('labelStoppingOthers'));
      this.setButtonLabel('[data-screen-stop-others]', 'labelStoppingOthers');
      await (this.deps.delay ?? delay)(Math.max(stopped.retryAfterSeconds, 3) * 1000);
      if (!this.isActiveRun(run)) {
        this.cancelStart(run);
        return;
      }
      await this.continueStart(run);
    } catch (error) {
      if (run) this.cancelStart(run);
      if (this.isActiveStart(generation)) this.handleStartError(error);
    } finally {
      if (run && this.activeStart === run) this.activeStart = null;
      this.releaseStartReservation(generation);
      this.setBusy('[data-screen-stop-others]', false, 'labelStopOthers');
      if (retry) retry.disabled = false;
    }
  }

  private async continueStart(run: StartRun): Promise<void> {
    const started = await this.createAndPublish(run);
    if (!started) return;
    const stream = started.live;
    if (!this.isActiveRun(run)) {
      this.discardInactiveRun(stream, run);
      return;
    }
    this.live = stream;
    this.setUrl(stream.streamUrl);
    this.setAudioStatus(stream.capture.media);
    this.preview(stream.capture.media);
    this.startTimers();
    stream.capture.media.getVideoTracks()[0]?.addEventListener('ended', () => void this.stop());
    if (started.ready) this.show('url');
    else this.showError(new StreamHealthError());
  }

  private async createAndPublish(run: StartRun): Promise<StartedStream | null> {
    let created: CreateStreamResponse;
    try {
      created = asCreateStream(await this.deps.requestJson('/api/streams/', {
        method: 'POST',
        signal: run.abortController.signal,
      }));
    } catch (error) {
      this.cancelStart(run);
      throw error;
    }
    if (!this.isActiveRun(run)) {
      this.cancelStart(run);
      void this.notifyServerStop(created.id);
      return null;
    }
    return this.publishAndVerify(run, created);
  }

  private async publishAndVerify(
    run: StartRun,
    created: CreateStreamResponse
  ): Promise<StartedStream | null> {
    let publisher: WhipPublisher | null = null;
    let stream: LiveStream | null = null;
    try {
      publisher = await this.deps.startWhipPublisher({
        stream: run.capture.media,
        streamId: created.id,
        publishToken: created.publishToken,
        keyframeRequestIntervalMs: keyframeRequestIntervalForSearch(globalThis.window?.location?.search ?? ''),
        audioProfile: currentAudioProfile(),
      });
      stream = {
        ...created,
        publisher,
        media: run.capture.media,
        capture: run.capture,
        abortController: run.abortController,
        lifecycle: {
          localReleased: false,
          serverStopRequested: false,
          whipDeleteRequested: false,
        },
      };
      if (!this.isActiveRun(run)) {
        this.discardInactiveRun(stream, run);
        return null;
      }
      this.live = stream;
      return await this.verifyInitialStream(stream, run);
    } catch (error) {
      if (stream) {
        const stale = !this.isActiveRun(run) || !this.isActiveLive(stream);
        this.discardInactiveRun(stream, run);
        if (stale) return null;
        throw error;
      }
      this.cancelStart(run);
      void this.notifyServerStop(created.id);
      throw error;
    }
  }

  private async verifyInitialStream(stream: LiveStream, run: StartRun): Promise<StartedStream | null> {
    const ready = await this.deps.waitForStreamReady(stream.id, run.abortController.signal);
    if (!this.isActiveRun(run) || !this.isActiveLive(stream)) {
      this.discardInactiveRun(stream, run);
      return null;
    }
    if (ready) return { live: stream, ready: true };
    const replacement = await stream.publisher.republish();
    if (!this.isActiveRun(run) || !this.isActiveLive(stream)) {
      await this.releasePublisher(replacement);
      this.discardInactiveRun(stream, run);
      return null;
    }
    stream.publisher = replacement;
    const retryReady = await this.deps.waitForStreamReady(stream.id, run.abortController.signal);
    if (!this.isActiveRun(run) || !this.isActiveLive(stream)) {
      this.discardInactiveRun(stream, run);
      return null;
    }
    return { live: stream, ready: retryReady };
  }

  private async copyUrl(): Promise<void> {
    const input = this.root.querySelector<HTMLInputElement>('[data-screen-url]');
    if (!input) return;
    const copied = await copyToClipboard(input.value, input);
    this.setButtonLabel('[data-screen-copy]', copied ? 'labelCopied' : 'labelCopy');
  }

  private async retry(): Promise<void> {
    const live = this.live;
    if (!live) {
      await this.selectScreen();
      return;
    }
    this.setBusy('[data-screen-retry]', true, 'labelReconnecting');
    try {
      const publisher = await live.publisher.republish();
      if (!this.isActiveLive(live)) {
        await this.releasePublisher(publisher);
        return;
      }
      live.publisher = publisher;
      const ready = await this.deps.waitForStreamReady(live.id, live.abortController.signal);
      if (!this.isActiveLive(live)) return;
      if (ready) {
        this.setUrl(live.streamUrl);
        this.show('url');
      } else {
        this.showError(new StreamHealthError());
      }
    } catch (error) {
      if (!this.isActiveLive(live)) return;
      const stopped = this.finishLocally('error', error);
      if (stopped) await this.notifyRemoteStop(stopped);
    } finally {
      this.setBusy('[data-screen-retry]', false, this.live ? 'labelReconnect' : 'labelRetry');
    }
  }

  private async extend(): Promise<void> {
    const live = this.live;
    if (!live || this.stopping) return;
    this.setBusy('[data-screen-extend]', true, 'labelExtending');
    try {
      const response = asExtendStream(
        await this.deps.requestJson(`/api/streams/${encodeURIComponent(live.id)}/extend/`, {
          method: 'POST',
          signal: live.abortController.signal,
        })
      );
      if (this.stopping || this.live !== live) return;
      live.extendExpiresAt = response.extendExpiresAt;
      live.publishToken = response.publishToken;
      live.publisher.setPublishToken(response.publishToken);
      this.updateClock();
    } catch (error) {
      if (!this.stopping && this.live === live) this.handleRuntimeError(error);
    } finally {
      this.setBusy('[data-screen-extend]', false, 'labelExtend');
    }
  }

  private async stop(): Promise<void> {
    const live = this.finishLocally('idle');
    if (live) await this.notifyRemoteStop(live);
  }

  private startTimers(): void {
    this.clearTimers();
    this.updateClock();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.clockTimer = setInterval(() => this.updateClock(), 1_000);
  }

  private async heartbeat(): Promise<void> {
    const live = this.live;
    if (!live || this.stopping) return;
    try {
      await this.deps.requestJson(`/api/streams/${encodeURIComponent(live.id)}/heartbeat/`, {
        method: 'POST',
        signal: live.abortController.signal,
      });
    } catch (error) {
      if (!this.stopping && this.live === live) this.handleRuntimeError(error);
    }
  }

  private updateClock(): void {
    if (!this.live) return;
    const now = this.deps.now();
    const remaining = secondsUntil(this.live.extendExpiresAt, now);
    this.text('[data-screen-elapsed]', formatDuration((now - Date.parse(this.live.startedAt)) / 1000));
    this.text('[data-screen-expires]', formatDuration(remaining));
    const warning = this.root.querySelector<HTMLElement>('[data-screen-expiry-warning]');
    if (warning) warning.hidden = !isExpiryWarning(this.live.extendExpiresAt, now);
  }

  private handleStartError(error: unknown): void {
    if (isUnauthorizedRequestError(error)) return this.show('login');
    this.showError(error);
  }

  private handleRuntimeError(error: unknown): void {
    const live = this.finishLocally('error', error);
    if (live) void this.notifyRemoteStop(live);
  }

  private finishLocally(phase: 'idle' | 'error', error?: unknown): LiveStream | null {
    if (this.stopping) return null;
    this.stopping = true;
    this.startGeneration += 1;
    const run = this.activeStart;
    this.activeStart = null;
    run?.abortController.abort();
    const live = this.live;
    live?.abortController.abort();
    if (live) this.releaseLiveLocally(live, true);
    else run?.capture.dispose();
    this.live = null;
    if (phase === 'error') this.showError(error);
    else this.show('idle');
    return live;
  }

  private stopForPageHide(): void {
    const live = this.finishLocally('idle');
    if (!live) return;
    void this.notifyLiveServerStop(live, true);
    void this.notifyWhipDeletion(live);
  }

  private async notifyRemoteStop(live: LiveStream): Promise<void> {
    await Promise.all([this.notifyLiveServerStop(live), this.notifyWhipDeletion(live)]);
  }

  private async notifyLiveServerStop(live: LiveStream, preferBeacon = false): Promise<void> {
    if (live.lifecycle.serverStopRequested) return;
    live.lifecycle.serverStopRequested = true;
    if (preferBeacon) {
      try {
        if (this.deps.sendBeacon(streamStopUrl(live.id))) return;
      } catch (error) {
        console.warn('Failed to queue stream stop beacon', error);
      }
    }
    await this.notifyServerStop(live.id);
  }

  private async notifyServerStop(id: string): Promise<void> {
    try {
      await this.deps.requestJson(streamStopUrl(id), { method: 'POST' });
    } catch (error) {
      console.warn('Failed to stop stream session remotely', error);
    }
  }

  private async notifyWhipDeletion(live: LiveStream): Promise<void> {
    if (live.lifecycle.whipDeleteRequested) return;
    live.lifecycle.whipDeleteRequested = true;
    await live.publisher.deleteResource().catch((error) => {
      console.warn('Failed to delete WHIP resource', error);
    });
  }

  private async releasePublisher(publisher: WhipPublisher): Promise<void> {
    publisher.close();
    await publisher.deleteResource().catch((error) => {
      console.warn('Failed to delete WHIP resource', error);
    });
  }

  private isActiveStart(generation: number): boolean {
    return !this.stopping && this.startGeneration === generation;
  }

  private isActiveRun(run: StartRun): boolean {
    return (
      this.activeStart === run &&
      this.isActiveStart(run.generation) &&
      !run.abortController.signal.aborted
    );
  }

  private reserveStart(): number | null {
    if (this.startReservation !== null || this.activeStart || this.live) return null;
    this.stopping = false;
    const generation = ++this.startGeneration;
    this.startReservation = generation;
    return generation;
  }

  private releaseStartReservation(generation: number): void {
    if (this.startReservation === generation) this.startReservation = null;
  }

  private registerStart(media: MediaStream, generation: number): StartRun | null {
    const run: StartRun = {
      generation,
      capture: createCaptureHandle(media),
      abortController: new AbortController(),
    };
    if (this.startReservation !== generation || !this.isActiveStart(generation)) {
      this.cancelStart(run);
      return null;
    }
    if (this.activeStart || this.live) {
      this.cancelStart(run);
      return null;
    }
    this.activeStart = run;
    return run;
  }

  private cancelStart(run: StartRun): void {
    run.abortController.abort();
    run.capture.dispose();
    if (this.activeStart === run) this.activeStart = null;
  }

  private discardInactiveRun(stream: LiveStream, run: StartRun): void {
    this.cancelStart(run);
    const wasCurrent = this.live === stream;
    if (wasCurrent) this.live = null;
    this.releaseLiveLocally(stream, wasCurrent);
    void this.notifyRemoteStop(stream);
  }

  private releaseLiveLocally(stream: LiveStream, clearCurrentTimers: boolean): void {
    if (stream.lifecycle.localReleased) return;
    stream.lifecycle.localReleased = true;
    releaseScreenShare(stream, clearCurrentTimers ? () => this.clearTimers() : () => undefined);
  }

  private isActiveLive(live: LiveStream): boolean {
    return !this.stopping && this.live === live;
  }

  private showError(error: unknown): void {
    this.text('[data-screen-error-message]', this.messageFor(error));
    this.setButtonLabel('[data-screen-retry]', this.live ? 'labelReconnect' : 'labelRetry');
    const stopOthers = this.button('[data-screen-stop-others]');
    if (stopOthers) {
      stopOthers.hidden = !isStreamAlreadyLiveError(error);
      stopOthers.disabled = false;
      this.setButtonLabel('[data-screen-stop-others]', 'labelStopOthers');
    }
    this.show('error');
  }

  private messageFor(error: unknown): string {
    if (error instanceof WhipPublishError) {
      return this.message(error.code === 'H264_UNAVAILABLE' ? 'msgH264' : 'msgWhip');
    }
    if (error instanceof JsonRequestError) {
      if (error.errorCode === ERROR_CODES.streamAlreadyLive) return this.message('msgStreamAlreadyLive');
      if (error.errorCode === ERROR_CODES.streamCapacityReached) return this.message('msgStreamCapacity');
      if (error.errorCode === ERROR_CODES.streamCreateRateLimited) return this.message('msgRateLimited');
      if (error.errorCode === ERROR_CODES.streamEnded) return this.message('msgStreamEnded');
    }
    if (error instanceof StreamHealthError) return this.message('msgStreamUnhealthy');
    if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
      return this.message('msgDisplayDenied');
    }
    return this.message('msgGeneric');
  }

  private show(phase: ScreenSharePhase): void {
    this.phase = phase;
    for (const step of this.root.querySelectorAll<HTMLElement>('[data-screen-step]')) {
      step.hidden = step.dataset['screenStep'] !== phase;
    }
    // 開始前（idle / login / error）は進捗を示す段階がないのでドットごと隠す。
    const active = phase === 'url' ? '1' : phase === 'live' ? '2' : null;
    const indicators = this.root.querySelector<HTMLElement>('[data-screen-indicators]');
    if (indicators) indicators.hidden = active === null;
    for (const indicator of this.root.querySelectorAll<HTMLElement>('[data-screen-indicator]')) {
      indicator.dataset['active'] = indicator.dataset['screenIndicator'] === active ? 'true' : 'false';
    }
  }

  private preview(media: MediaStream): void {
    const video = this.root.querySelector<HTMLVideoElement>('[data-screen-preview]');
    if (video) video.srcObject = media;
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
    this.heartbeatTimer = null;
    this.clockTimer = null;
  }

  private setUrl(url: string): void {
    const input = this.root.querySelector<HTMLInputElement>('[data-screen-url]');
    if (input) input.value = url;
  }

  private setAudioStatus(media: MediaStream): void {
    const key = media.getAudioTracks().length > 0 ? 'msgAudioIncluded' : 'msgVideoOnly';
    this.text('[data-screen-audio-status]', this.message(key));
  }

  private setBusy(selector: string, busy: boolean, label: string): void {
    const button = this.button(selector);
    if (!button) return;
    button.disabled = busy;
    this.setButtonLabel(selector, label);
  }

  private setButtonLabel(selector: string, label: string): void {
    const button = this.button(selector);
    // ラベル用の span があればそこだけ差し替える（button 直下の FontAwesome アイコンを消さない）
    if (button) (button.querySelector('span') ?? button).textContent = this.message(label);
  }

  private message(key: string): string {
    return this.root.dataset[key] ?? '';
  }

  private text(selector: string, value: string): void {
    const element = this.root.querySelector<HTMLElement>(selector);
    if (element) element.textContent = value;
  }

  private button(selector: string): HTMLButtonElement | null {
    return this.root.querySelector<HTMLButtonElement>(selector);
  }
}

function displayMediaConstraints(profile: AudioProfile): MediaStreamConstraints {
  return {
    // ピッカーは既定のまま（画面全体・ウィンドウ・タブから選ばせる）。検証時の
    // preferCurrentTab は macOS 権限回避用で、自タブ共有は製品では意味がない。
    // macOS の画面収録が未許可だと NotAllowedError になる（displayDenied 文言で案内）
    video: {
      width: { ideal: SCREEN_SHARE_VIDEO_SETTINGS.width },
      height: { ideal: SCREEN_SHARE_VIDEO_SETTINGS.height },
      frameRate: { ideal: SCREEN_SHARE_VIDEO_SETTINGS.frameRate, max: SCREEN_SHARE_VIDEO_SETTINGS.frameRate },
    },
    audio: displayAudioConstraint(profile),
  };
}

function currentAudioProfile(): AudioProfile {
  return resolveAudioProfileForSearch(globalThis.window?.location?.search ?? '');
}

function asCreateStream(value: unknown): CreateStreamResponse {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.streamUrl !== 'string' || typeof value.publishToken !== 'string' || typeof value.startedAt !== 'string' || typeof value.extendExpiresAt !== 'string') {
    throw new Error('Invalid create stream response');
  }
  return value as unknown as CreateStreamResponse;
}

function asExtendStream(value: unknown): ExtendStreamResponse {
  if (!isRecord(value) || typeof value.extendExpiresAt !== 'string' || typeof value.publishToken !== 'string') {
    throw new Error('Invalid extend stream response');
  }
  return value as unknown as ExtendStreamResponse;
}

function asStopLiveStreams(value: unknown): StopLiveStreamsResponse {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.stopped) ||
    !isNonNegativeInteger(value.retryAfterSeconds)
  ) {
    throw new Error('Invalid stop live streams response');
  }
  return value as unknown as StopLiveStreamsResponse;
}

function isStreamAlreadyLiveError(error: unknown): boolean {
  return error instanceof JsonRequestError && error.errorCode === ERROR_CODES.streamAlreadyLive;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

const CAPTURE_HANDLES = new WeakMap<MediaStream, CaptureHandle>();

function createCaptureHandle(media: MediaStream): CaptureHandle {
  const existing = CAPTURE_HANDLES.get(media);
  if (existing) return existing;
  let disposed = false;
  const capture = {
    media,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const track of media.getTracks()) track.stop();
    },
  };
  CAPTURE_HANDLES.set(media, capture);
  return capture;
}

function streamStopUrl(id: string): string {
  return `/api/streams/${encodeURIComponent(id)}/stop/`;
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(rounded / 60);
  const remaining = String(rounded % 60).padStart(2, '0');
  return `${minutes}:${remaining}`;
}
