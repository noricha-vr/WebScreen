import { copyToClipboard } from '../clipboard';
import { configureCaptureAudioTracks } from '../audio-profile';
import { keyframeRequestIntervalForSearch, reusableStreamIdForSearch } from '../stream-profile';
import type { WhipPublisher } from '../whip-publisher';
import { currentAudioProfile, displayMediaConstraints } from './capture';
import { LiveStreamSession, releasePublisher, StartRun } from './session';
import { createStreamApi, type StreamApi } from './stream-api';
import { resolveScreenShareVideoSettingsForSearch } from './video-profile';
import {
  currentSearch,
  delay,
  durationUntil,
} from './controller-helpers';
import {
  isStreamIdNotReusableError,
  ScreenShareView,
  StreamHealthError,
} from './view';
import { ScreenShareDiagnostics } from './controller-diagnostics';
import { StreamRemoteCleanup } from './remote-cleanup';
import { updateStreamClock } from './controller-clock';
import { StartCoordinator } from './start-coordinator';
import { publisherReadiness } from './stream-readiness';
import { bindScreenShareActions } from './controller-bindings';
import { ScreenShareAnalyticsObserver } from './screen-share-analytics';
import type { ScreenShareDependencies } from './controller-dependencies';
export type { ScreenShareDependencies } from './controller-dependencies';

type StartedStream = { live: LiveStreamSession; ready: boolean };
/** 画面共有 UI のイベントと非同期ライフサイクルを調停する。 */
export class ScreenShareControllerImpl {
  private readonly view: ScreenShareView;
  private readonly api: StreamApi;
  private readonly cleanup: StreamRemoteCleanup;
  private live: LiveStreamSession | null = null;
  private readonly starts = new StartCoordinator();
  private expiresBarTotalSeconds = 0;
  private reuseDisabled = false;
  private readonly diagnostics: ScreenShareDiagnostics;
  private readonly analytics: ScreenShareAnalyticsObserver;
  constructor(
    root: HTMLElement,
    private readonly deps: ScreenShareDependencies
  ) {
    this.view = new ScreenShareView(root, deps.previewPreference);
    this.diagnostics = new ScreenShareDiagnostics(this.view, deps.now, deps.reportStreamFailure);
    this.analytics = new ScreenShareAnalyticsObserver(deps.trackAnalytics);
    this.api = createStreamApi(
      deps.requestJson,
      deps.sendBeacon,
      deps.delay,
      deps.waitForStreamReady
    );
    this.cleanup = new StreamRemoteCleanup(this.api);
  }
  mount(): void {
    // getDisplayMedia はクリック起点で直接呼び、user activation を失わない。
    bindScreenShareActions(this.view, this.deps.onPageHide, {
      start: (stopOthers) => void this.beginStart(stopOthers),
      copyUrl: () => void this.copyUrl(), copyDiagnostics: () => void this.copyDiagnostics(),
      stop: () => void this.stop(), retry: () => void this.retry(),
      pageHide: () => this.stopForPageHide(),
    });
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
      this.analytics.emit('screen_share_start');
      this.view.setBusy('[data-screen-start]', true, 'labelStarting');
      configureCaptureAudioTracks(media, profile);
      // 競合配信の停止中は error ステップの「停止中…」を保ち、完了後に開始待機へ進める。
      if (stopOthers) await this.stopOthers(run);
      if (!this.isActiveRun(run)) return;
      this.view.show('starting');
      await this.continueStart(run);
    } catch (error) {
      if (run) this.cancelStart(run);
      // NotAllowedError は選択のキャンセルだけでなく OS の画面収録権限拒否でも出るため、
      // idle へ黙って戻さず displayDenied の案内を出す。
      if (this.isActiveStart(generation)) this.handleStartError(error, run?.capture.media ?? null);
    } finally {
      if (run) this.starts.finish(run);
      this.starts.release(generation);
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
    if (started.ready) {
      this.markLiveSuccess(stream);
      return this.view.show('live');
    }
    // 映像が届かないまま health 未達。現 publisher の stats で分類する（旧値へフォールバックしない）。
    const stats = await stream.publisher.videoStats();
    if (!this.isActiveLive(stream)) return; // videoStats 待機中に停止/pagehide されたら復活させない。
    this.diagnostics.recordFailure('healthTimeout', stats, stream.capture.media);
    this.diagnostics.showError(new StreamHealthError(), true);
  }

  private async createAndPublish(run: StartRun): Promise<StartedStream | null> {
    let created;
    try {
      created = await this.api.create(
        run.startToken,
        this.reuseDisabled ? undefined : reusableStreamIdForSearch(this.search())
      );
    } catch (error) {
      if (isStreamIdNotReusableError(error)) {
        // 同じ query を再送して 409 を繰り返さず、次の Retry は新しい URL を発行する。
        this.reuseDisabled = true;
      }
      this.cancelStart(run);
      throw error;
    }
    // 配信 ID を診断へ引き渡す（journald live/<id>・Cloudflare ログとの突合キー）。
    this.diagnostics.setStreamId(created.id);
    if (!this.isActiveRun(run)) {
      this.cancelStart(run);
      void this.cleanup.stopId(created.id);
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
        keyframeRequestIntervalMs: keyframeRequestIntervalForSearch(this.search()),
        audioProfile: currentAudioProfile(),
        videoSettings: resolveScreenShareVideoSettingsForSearch(this.search()),
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
      void this.cleanup.stopId(created.id);
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
    // health は音声込みの path 全体 bytes を見るため、音声だけ流れて H.264 未生成でも
    // ready になりうる。live 確定前に「映像 bytes が実際に出たか」を videoStats で確認する。
    const initial = await publisherReadiness(stream.publisher, ready);
    if (!this.isActiveRun(run) || !this.isActiveLive(stream)) {
      this.discardInactiveRun(stream, run);
      return null;
    }
    // 厳密に 0 バイト = H.264 未生成。ready でも live にせず no-video 失敗へ落とす。
    // republish しても Chrome は映像を出さないので 2回目の health 待機も省く。
    // undefined（取得不能）は live を妨げない（テレメトリ欠落で健全な配信を弾かない）。
    if (initial.stats?.bytesSent === 0) return { live: stream, ready: false };
    if (initial.ready) return { live: stream, ready: true };
    // republish は close を同期実行する。失敗して publisher が死ぬ経路の診断用に、
    // ここでだけ現 publisher の stats を退避する（republish 成功後の分類には使わない）。
    this.diagnostics.rememberStats(initial.stats);
    // 復旧 republish が失敗した publisher は PeerConnection を閉じ失敗 Promise をキャッシュし再接続不能。
    // WHIP エラー（サーバー接続不可）で誤誘導せず StreamHealthError（映像未到達）で破棄し、再選択へ導く。
    const replacement = await stream.publisher.republish().catch((error: unknown) => {
      console.warn('Screen share republish during health verify failed', error);
      throw new StreamHealthError();
    });
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
    const retry = await publisherReadiness(stream.publisher, retryReady);
    if (!this.isActiveRun(run) || !this.isActiveLive(stream)) {
      this.discardInactiveRun(stream, run);
      return null;
    }
    return { live: stream, ready: retry.ready };
  }

  private async copyUrl(): Promise<void> {
    const input = this.view.urlInput();
    if (!input) return;
    const copied = await copyToClipboard(input.value, input);
    this.view.setButtonLabel('[data-screen-copy]', copied ? 'labelCopied' : 'labelCopy');
    if (copied) this.analytics.emit('screen_share_url_copy');
  }

  private async copyDiagnostics(): Promise<void> {
    const snapshot = this.diagnostics.snapshotJson();
    if (!snapshot) return;
    const copied = await copyToClipboard(snapshot, null);
    this.view.setButtonLabel(
      '[data-screen-copy-diagnostics]',
      copied ? 'labelDiagnosticsCopied' : 'labelDiagnosticsCopy'
    );
  }

  private async retry(): Promise<void> {
    const live = this.live;
    if (!live) return this.beginStart(false);
    this.view.setBusy('[data-screen-retry]', true, 'labelReconnecting');
    try {
      const publisher = await live.publisher.republish();
      if (!this.isActiveLive(live)) return void await releasePublisher(publisher);
      live.publisher = publisher;
      const healthReady = await this.api.waitForReady(live.id, live.abortController.signal);
      if (!this.isActiveLive(live)) return;
      const readiness = await publisherReadiness(live.publisher, healthReady);
      if (!this.isActiveLive(live)) return;
      if (readiness.ready) {
        this.markLiveSuccess(live);
        this.view.setUrl(live.streamUrl);
        this.view.show('live');
      } else {
        // 再接続しても映像が届かない。現 publisher の stats で分類する（旧値へフォールバックしない）。
        this.diagnostics.recordFailure('healthTimeout', readiness.stats, live.capture.media);
        this.diagnostics.showError(new StreamHealthError(), true);
      }
    } catch (error) {
      if (!this.isActiveLive(live)) return;
      const stopped = this.finishLocally('error', error);
      if (stopped) await this.cleanup.stopAll(stopped);
    } finally {
      this.view.setBusy('[data-screen-retry]', false, this.live ? 'labelReconnect' : 'labelRetry');
    }
  }

  private async stop(): Promise<void> {
    const live = this.finishLocally('idle');
    if (live) await this.cleanup.stopAll(live);
  }

  private async heartbeat(): Promise<void> {
    const live = this.live;
    if (!live || this.starts.isStopping) return;
    try {
      await this.api.heartbeat(live.id, live.abortController.signal);
    } catch (error) {
      if (!this.starts.isStopping && this.live === live) this.handleRuntimeError(error);
    }
  }

  private updateClock(): void {
    const live = this.live;
    if (!live) return;
    // cron の kick を待たず、期限ちょうどでこのブラウザの capture と PeerConnection を閉じる。
    if (updateStreamClock(this.view, live, this.expiresBarTotalSeconds, this.deps.now())) {
      void this.stop();
    }
  }

  private handleStartError(error: unknown, media: MediaStream | null): void {
    this.diagnostics.handleStartError(error, media, Boolean(this.live));
  }

  /** live 表示に到達したら診断を捨てる（後続の別エラーで古い診断をコピーさせない）。 */
  private markLiveSuccess(stream: LiveStreamSession): void {
    this.diagnostics.markSuccess();
    this.analytics.ready(stream);
  }

  private handleRuntimeError(error: unknown): void {
    const live = this.finishLocally('error', error);
    if (live) void this.cleanup.stopAll(live);
  }

  private finishLocally(phase: 'idle' | 'error', error?: unknown): LiveStreamSession | null {
    const run = this.starts.beginStop();
    if (run === undefined) return null;
    const live = this.live;
    live?.abortController.abort();
    if (live) live.closeLocal();
    else run?.capture.dispose();
    this.live = null;
    // ランタイム/再接続エラーは分類しない診断対象外の経路なので、古い診断は残さない。
    if (phase === 'error') {
      this.diagnostics.clearAndShowError(error, false);
    } else this.view.show('idle');
    return live;
  }

  private stopForPageHide(): void {
    const run = this.starts.current;
    const live = this.finishLocally('idle');
    if (live) {
      void this.cleanup.stopLiveServer(live, true);
      void this.cleanup.deleteWhip(live);
    } else if (run) void this.cleanup.cancelStart(run, true);
  }

  private reserveStart(): number | null {
    const generation = this.starts.reserve(Boolean(this.live));
    if (generation === null) return null;
    // 前回の試行の診断値を持ち越さない（無関係な次の失敗で古い stream id をコピーさせない）。
    this.diagnostics.reset();
    return generation;
  }

  private registerStart(media: MediaStream, generation: number): StartRun | null {
    const token = this.deps.createStartToken?.() ?? globalThis.crypto.randomUUID();
    return this.starts.register(media, generation, token, Boolean(this.live));
  }

  private cancelStart(run: StartRun): void {
    this.starts.cancel(run);
  }

  private discardInactiveRun(stream: LiveStreamSession, run: StartRun): null {
    this.cancelStart(run);
    if (this.live === stream) this.live = null;
    stream.closeLocal();
    void this.cleanup.stopAll(stream);
    return null;
  }

  private isActiveStart(generation: number): boolean {
    return this.starts.isGenerationActive(generation);
  }

  private isActiveRun(run: StartRun): boolean {
    return this.starts.isRunActive(run);
  }

  private isActiveLive(live: LiveStreamSession): boolean {
    return !this.starts.isStopping && this.live === live;
  }

  private search(): string {
    return this.deps.search?.() ?? currentSearch();
  }

}
