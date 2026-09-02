import { copyToClipboard } from '../clipboard';
import { isUnauthorizedRequestError, type requestJson } from '../request-json';
import { configureCaptureAudioTracks } from '../audio-profile';
import { keyframeRequestIntervalForSearch } from '../stream-profile';
import type { startWhipPublisher, WhipPublisher } from '../whip-publisher';
import { currentAudioProfile, displayMediaConstraints } from './capture';
import { isExpiryWarning, LiveStreamSession, releasePublisher, secondsUntil, StartRun } from './session';
import { createStreamApi, type StreamApi } from './stream-api';
import { resolveScreenShareVideoSettingsForSearch } from './video-profile';
import {
  isStreamAlreadyLiveError,
  messageKeyForError,
  ScreenShareView,
  StreamHealthError,
} from './view';
/** DOM controller の外部境界。テストでは画面・API・WHIP を独立して差し替える。 */
export interface ScreenShareDependencies {
  requestJson: typeof requestJson;
  startWhipPublisher: typeof startWhipPublisher;
  waitForStreamReady: (streamId: string, signal?: AbortSignal) => Promise<boolean>;
  getDisplayMedia: typeof navigator.mediaDevices.getDisplayMedia;
  delay?: (ms: number) => Promise<void>;
  now: () => number;
  createStartToken?: () => string;
  sendBeacon: (url: string, data?: BodyInit | null) => boolean;
  onPageHide: (handler: () => void) => void;
}

type StartedStream = { live: LiveStreamSession; ready: boolean };
/** 画面共有 UI のイベントと非同期ライフサイクルを調停する。 */
export class ScreenShareControllerImpl {
  private readonly view: ScreenShareView;
  private readonly api: StreamApi;
  private live: LiveStreamSession | null = null;
  private stopping = false;
  private startGeneration = 0;
  private startReservation: number | null = null;
  private activeStart: StartRun | null = null;
  private expiresBarTotalSeconds = 0;
  constructor(
    root: HTMLElement,
    private readonly deps: ScreenShareDependencies
  ) {
    this.view = new ScreenShareView(root);
    this.api = createStreamApi(
      deps.requestJson,
      deps.sendBeacon,
      deps.delay,
      deps.waitForStreamReady
    );
  }
  mount(): void {
    // getDisplayMedia はクリック起点で直接呼び、user activation を失わない。
    this.view.onClick('[data-screen-start]', () => void this.beginStart(false));
    this.view.onClick('[data-screen-copy]', () => void this.copyUrl());
    this.view.onClick('[data-screen-extend]', () => void this.extend());
    this.view.onClick('[data-screen-stop]', () => void this.stop());
    this.view.onClick('[data-screen-retry]', () => void this.retry());
    this.view.onClick('[data-screen-stop-others]', () => void this.beginStart(true));
    this.view.onClick('[data-screen-preview-toggle]', () => this.view.togglePreview());
    this.view.onModeClick((mode) => this.view.selectMode(mode));
    this.deps.onPageHide(() => this.stopForPageHide());
    this.view.show('idle');
  }
  private async beginStart(stopOthers: boolean): Promise<void> {
    const generation = this.reserveStart();
    if (generation === null) return;
    const selector = stopOthers ? '[data-screen-stop-others]' : '[data-screen-start]';
    const idleLabel = stopOthers ? 'labelStopOthers' : 'labelStart';
    let run: StartRun | null = null;
    this.view.setBusy(selector, true, stopOthers ? 'labelStopOthers' : 'labelSelecting');
    this.view.setDisabled('[data-screen-retry]', true);
    try {
      const profile = currentAudioProfile();
      const media = await this.deps.getDisplayMedia(displayMediaConstraints(profile));
      run = this.registerStart(media, generation);
      if (!run) return;
      this.view.setBusy('[data-screen-start]', true, 'labelStarting');
      configureCaptureAudioTracks(media, profile);
      if (stopOthers) await this.stopOthers(run);
      if (this.isActiveRun(run)) await this.continueStart(run);
    } catch (error) {
      if (run) this.cancelStart(run);
      if (this.isActiveStart(generation)) this.handleStartError(error);
    } finally {
      if (run && this.activeStart === run) this.activeStart = null;
      this.releaseStartReservation(generation);
      this.view.setBusy(selector, false, idleLabel);
      this.view.setBusy('[data-screen-start]', false, 'labelStart');
      this.view.setDisabled('[data-screen-retry]', false);
    }
  }

  private async stopOthers(run: StartRun): Promise<void> {
    const stopped = await this.api.stopLive(run.abortController.signal);
    if (!this.isActiveRun(run)) return this.cancelStart(run);
    this.view.showStoppingOthers();
    await (this.deps.delay ?? delay)(Math.max(stopped.retryAfterSeconds, 3) * 1000);
    if (!this.isActiveRun(run)) this.cancelStart(run);
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
    this.view.setUrl(stream.streamUrl);
    this.view.setAudioStatus(stream.capture.media);
    this.view.setPreview(stream.capture.media);
    this.expiresBarTotalSeconds = durationUntil(stream.extendExpiresAt, Date.parse(stream.startedAt));
    stream.startTimers(() => void this.heartbeat(), () => this.updateClock());
    stream.capture.media.getVideoTracks()[0]?.addEventListener('ended', () => void this.stop());
    if (started.ready) this.view.show('live');
    else this.showError(new StreamHealthError());
  }

  private async createAndPublish(run: StartRun): Promise<StartedStream | null> {
    let created;
    try {
      created = await this.api.create(run.startToken);
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
    created: Awaited<ReturnType<StreamApi['create']>>
  ): Promise<StartedStream | null> {
    let publisher: WhipPublisher | null = null;
    let stream: LiveStreamSession | null = null;
    try {
      publisher = await this.deps.startWhipPublisher({
        stream: run.capture.media,
        streamId: created.id,
        publishToken: created.publishToken,
        keyframeRequestIntervalMs: keyframeRequestIntervalForSearch(currentSearch()),
        audioProfile: currentAudioProfile(),
        videoSettings: resolveScreenShareVideoSettingsForSearch(currentSearch()),
      });
      stream = new LiveStreamSession(created, publisher, run);
      if (!this.isActiveRun(run)) return this.discardInactiveRun(stream, run);
      // WHIP 確立直後から pagehide/stop の停止対象にする。
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

  private async verifyInitialStream(
    stream: LiveStreamSession,
    run: StartRun
  ): Promise<StartedStream | null> {
    const ready = await this.api.waitForReady(stream.id, run.abortController.signal);
    if (!this.isActiveRun(run) || !this.isActiveLive(stream)) {
      this.discardInactiveRun(stream, run);
      return null;
    }
    if (ready) return { live: stream, ready: true };
    const replacement = await stream.publisher.republish();
    if (!this.isActiveRun(run) || !this.isActiveLive(stream)) {
      await releasePublisher(replacement);
      this.discardInactiveRun(stream, run);
      return null;
    }
    stream.publisher = replacement;
    const retryReady = await this.api.waitForReady(stream.id, run.abortController.signal);
    if (!this.isActiveRun(run) || !this.isActiveLive(stream)) {
      this.discardInactiveRun(stream, run);
      return null;
    }
    return { live: stream, ready: retryReady };
  }

  private async copyUrl(): Promise<void> {
    const input = this.view.urlInput();
    if (!input) return;
    const copied = await copyToClipboard(input.value, input);
    this.view.setButtonLabel('[data-screen-copy]', copied ? 'labelCopied' : 'labelCopy');
  }

  private async retry(): Promise<void> {
    const live = this.live;
    if (!live) return this.beginStart(false);
    this.view.setBusy('[data-screen-retry]', true, 'labelReconnecting');
    try {
      const publisher = await live.publisher.republish();
      if (!this.isActiveLive(live)) return void await releasePublisher(publisher);
      live.publisher = publisher;
      const ready = await this.api.waitForReady(live.id, live.abortController.signal);
      if (!this.isActiveLive(live)) return;
      if (ready) {
        this.view.setUrl(live.streamUrl);
        this.view.show('live');
      } else this.showError(new StreamHealthError());
    } catch (error) {
      if (!this.isActiveLive(live)) return;
      const stopped = this.finishLocally('error', error);
      if (stopped) await this.notifyRemoteStop(stopped);
    } finally {
      this.view.setBusy('[data-screen-retry]', false, this.live ? 'labelReconnect' : 'labelRetry');
    }
  }

  private async extend(): Promise<void> {
    const live = this.live;
    if (!live || this.stopping) return;
    this.view.setBusy('[data-screen-extend]', true, 'labelExtending');
    try {
      const response = await this.api.extend(live.id, live.abortController.signal);
      if (this.stopping || this.live !== live) return;
      live.extendExpiresAt = response.extendExpiresAt;
      live.publishToken = response.publishToken;
      live.publishTokenExpiresAt = response.publishTokenExpiresAt;
      live.publisher.setPublishToken(response.publishToken);
      this.expiresBarTotalSeconds = durationUntil(response.extendExpiresAt, this.deps.now());
      this.updateClock();
    } catch (error) {
      if (!this.stopping && this.live === live) this.handleRuntimeError(error);
    } finally {
      this.view.setBusy('[data-screen-extend]', false, 'labelExtend');
    }
  }

  private async stop(): Promise<void> {
    const live = this.finishLocally('idle');
    if (live) await this.notifyRemoteStop(live);
  }

  private async heartbeat(): Promise<void> {
    const live = this.live;
    if (!live || this.stopping) return;
    try {
      await this.api.heartbeat(live.id, live.abortController.signal);
    } catch (error) {
      if (!this.stopping && this.live === live) this.handleRuntimeError(error);
    }
  }

  private updateClock(): void {
    if (!this.live) return;
    const now = this.deps.now();
    this.view.updateClock(
      this.live.startedAt,
      now,
      secondsUntil(this.live.extendExpiresAt, now),
      isExpiryWarning(this.live.extendExpiresAt, now),
      this.expiresBarTotalSeconds
    );
  }

  private handleStartError(error: unknown): void {
    if (isUnauthorizedRequestError(error)) return this.view.show('login');
    this.showError(error);
  }

  private handleRuntimeError(error: unknown): void {
    const live = this.finishLocally('error', error);
    if (live) void this.notifyRemoteStop(live);
  }

  private finishLocally(phase: 'idle' | 'error', error?: unknown): LiveStreamSession | null {
    if (this.stopping) return null;
    this.stopping = true;
    this.startGeneration += 1;
    const run = this.activeStart;
    this.activeStart = null;
    run?.abortController.abort();
    const live = this.live;
    live?.abortController.abort();
    if (live) live.closeLocal();
    else run?.capture.dispose();
    this.live = null;
    if (phase === 'error') this.showError(error);
    else this.view.show('idle');
    return live;
  }

  private stopForPageHide(): void {
    const run = this.activeStart;
    const live = this.finishLocally('idle');
    if (live) {
      void this.notifyLiveServerStop(live, true);
      void this.notifyWhipDeletion(live);
    } else if (run) void this.notifyStartCancellation(run, true);
  }

  private async notifyRemoteStop(live: LiveStreamSession): Promise<void> {
    await Promise.all([this.notifyLiveServerStop(live), this.notifyWhipDeletion(live)]);
  }

  private async notifyLiveServerStop(live: LiveStreamSession, beacon = false): Promise<void> {
    if (!live.claimServerStop()) return;
    await this.notifyServerStop(live.id, beacon);
  }

  private async notifyServerStop(id: string, beacon = false): Promise<void> {
    try { await this.api.stop(id, beacon); }
    catch (error) { console.warn('Failed to stop stream session remotely', error); }
  }

  private async notifyStartCancellation(run: StartRun, beacon = false): Promise<void> {
    if (run.cancellationRequested) return;
    run.cancellationRequested = true;
    try { await this.api.cancelStart(run.startToken, beacon); }
    catch (error) { console.warn('Failed to cancel stream start remotely', error); }
  }

  private async notifyWhipDeletion(live: LiveStreamSession): Promise<void> {
    if (!live.claimWhipDelete()) return;
    await live.publisher.deleteResource().catch((error) => {
      console.warn('Failed to delete WHIP resource', error);
    });
  }

  private reserveStart(): number | null {
    if (this.startReservation !== null || this.activeStart || this.live) return null;
    this.stopping = false;
    const generation = ++this.startGeneration;
    this.startReservation = generation;
    return generation;
  }

  private registerStart(media: MediaStream, generation: number): StartRun | null {
    const token = this.deps.createStartToken?.() ?? globalThis.crypto.randomUUID();
    const run = new StartRun(generation, token, media);
    if (this.startReservation !== generation || !this.isActiveStart(generation) ||
        this.activeStart || this.live) {
      run.cancel();
      return null;
    }
    this.activeStart = run;
    return run;
  }

  private cancelStart(run: StartRun): void {
    run.cancel();
    if (this.activeStart === run) this.activeStart = null;
  }

  private discardInactiveRun(stream: LiveStreamSession, run: StartRun): null {
    this.cancelStart(run);
    if (this.live === stream) this.live = null;
    stream.closeLocal();
    void this.notifyRemoteStop(stream);
    return null;
  }

  private releaseStartReservation(generation: number): void {
    if (this.startReservation === generation) this.startReservation = null;
  }

  private isActiveStart(generation: number): boolean {
    return !this.stopping && this.startGeneration === generation;
  }

  private isActiveRun(run: StartRun): boolean {
    return this.activeStart === run && this.isActiveStart(run.generation) &&
      !run.abortController.signal.aborted;
  }

  private isActiveLive(live: LiveStreamSession): boolean {
    return !this.stopping && this.live === live;
  }

  private showError(error: unknown): void {
    this.view.showError(messageKeyForError(error), Boolean(this.live), isStreamAlreadyLiveError(error));
  }
}
function currentSearch(): string {
  return globalThis.window?.location?.search ?? '';
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function durationUntil(expiresAt: string, from: number): number {
  return Math.max(0, (Date.parse(expiresAt) - from) / 1000);
}
