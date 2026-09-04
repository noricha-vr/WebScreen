import { copyToClipboard } from '../clipboard';
import { isUnauthorizedRequestError, type requestJson } from '../request-json';
import { configureCaptureAudioTracks } from '../audio-profile';
import { keyframeRequestIntervalForSearch, reusableStreamIdForSearch } from '../stream-profile';
import { WhipPublishError, type startWhipPublisher, type VideoPublishStats, type WhipPublisher } from '../whip-publisher';
import type { ClientErrorReport } from '../../contracts/client-error';
import { reportClientError } from '../client-error-report';
import { currentAudioProfile, displayMediaConstraints } from './capture';
import { isExpiryWarning, LiveStreamSession, releasePublisher, secondsUntil, StartRun } from './session';
import { createStreamApi, type StreamApi } from './stream-api';
import {
  buildStreamDiagnosticSnapshot,
  classifyStreamFailure,
  type StreamFailureKind,
} from './diagnostics';
import { resolveScreenShareVideoSettingsForSearch } from './video-profile';
import type { PreviewPreferenceStore } from './preview-preference';
import { RecordingController, type RecordingDependencies } from './recording';
import {
  currentSearch,
  delay,
  displaySurfaceOf,
  durationUntil,
  userAgentString,
  videoSettingsOf,
} from './controller-helpers';
import {
  isStreamAlreadyLiveError,
  isStreamEndedError,
  isStreamIdNotReusableError,
  messageKeyForError,
  retryAfterSecondsForError,
  ScreenShareView,
  StreamHealthError,
} from './view';
/** 録画の完了を待つ上限。超えたら録画は破棄せず、完了した時点で一覧へ積む。 */
const RECORDING_STOP_TIMEOUT_MS = 3000;

/** DOM controller の外部境界。テストでは画面・API・WHIP を独立して差し替える。 */
export interface ScreenShareDependencies extends RecordingDependencies {
  requestJson: typeof requestJson;
  startWhipPublisher: typeof startWhipPublisher;
  waitForStreamReady: (streamId: string, signal?: AbortSignal) => Promise<boolean>;
  getDisplayMedia: typeof navigator.mediaDevices.getDisplayMedia;
  previewPreference: PreviewPreferenceStore;
  delay?: (ms: number) => Promise<void>;
  createStartToken?: () => string;
  search?: () => string;
  sendBeacon: (url: string, data?: BodyInit | null) => boolean;
  onPageHide: (handler: () => void) => void;
  /** 失敗の匿名報告。既定は client-error-report の reportClientError。 */
  reportStreamFailure?: (report: ClientErrorReport) => void;
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
  private reuseDisabled = false;
  private readonly reportStreamFailure: (report: ClientErrorReport) => void;
  // 失敗診断用。lastVideoStats は publisher を閉じる前に採取した値を保持する。
  private lastStreamId: string | null = null;
  private lastVideoStats: VideoPublishStats | null = null;
  private lastDiagnostic: Record<string, unknown> | null = null;
  private readonly recording: RecordingController;
  constructor(
    root: HTMLElement,
    private readonly deps: ScreenShareDependencies
  ) {
    this.view = new ScreenShareView(root, deps.previewPreference);
    this.reportStreamFailure = deps.reportStreamFailure ?? reportClientError;
    this.api = createStreamApi(
      deps.requestJson,
      deps.sendBeacon,
      deps.delay,
      deps.waitForStreamReady
    );
    this.recording = new RecordingController(this.view, deps);
  }
  mount(): void {
    // getDisplayMedia はクリック起点で直接呼び、user activation を失わない。
    this.view.onClick('[data-screen-start]', () => void this.beginStart(false));
    this.view.onClick('[data-screen-copy]', () => void this.copyUrl());
    this.view.onClick('[data-screen-copy-diagnostics]', () => void this.copyDiagnostics());
    this.view.onClick('[data-screen-record]', () => void this.toggleRecording());
    this.view.onClick('[data-screen-extend]', () => void this.extend());
    this.view.onClick('[data-screen-stop]', () => void this.stop());
    this.view.onClick('[data-screen-retry]', () => void this.retry());
    this.view.onClick('[data-screen-stop-others]', () => void this.beginStart(true));
    this.view.onClick('[data-screen-preview-toggle]', () => this.view.togglePreview());
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
    if (started.ready) {
      this.markLiveSuccess();
      return this.view.show('live');
    }
    // 映像が届かないまま health 未達。現 publisher の stats で分類する（旧値へフォールバックしない）。
    const stats = await stream.publisher.videoStats();
    if (!this.isActiveLive(stream)) return; // videoStats 待機中に停止/pagehide されたら復活させない。
    this.recordStreamFailure('healthTimeout', stats, stream.capture.media);
    this.showError(new StreamHealthError());
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
    this.lastStreamId = created.id;
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
        whipUrl: created.whipUrl,
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
    // health は音声込みの path 全体 bytes を見るため、音声だけ流れて H.264 未生成でも
    // ready になりうる。live 確定前に「映像 bytes が実際に出たか」を videoStats で確認する。
    const initialStats = await stream.publisher.videoStats();
    if (!this.isActiveRun(run) || !this.isActiveLive(stream)) {
      this.discardInactiveRun(stream, run);
      return null;
    }
    // 厳密に 0 バイト = H.264 未生成。ready でも live にせず no-video 失敗へ落とす。
    // republish しても Chrome は映像を出さないので 2回目の health 待機も省く。
    // undefined（取得不能）は live を妨げない（テレメトリ欠落で健全な配信を弾かない）。
    if (initialStats?.bytesSent === 0) return { live: stream, ready: false };
    if (ready) return { live: stream, ready: true };
    // republish は close を同期実行する。失敗して publisher が死ぬ経路の診断用に、
    // ここでだけ現 publisher の stats を退避する（republish 成功後の分類には使わない）。
    this.lastVideoStats = initialStats;
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
    return { live: stream, ready: retryReady };
  }

  private async copyUrl(): Promise<void> {
    const input = this.view.urlInput();
    if (!input) return;
    const copied = await copyToClipboard(input.value, input);
    this.view.setButtonLabel('[data-screen-copy]', copied ? 'labelCopied' : 'labelCopy');
  }

  private async copyDiagnostics(): Promise<void> {
    const snapshot = this.lastDiagnostic;
    if (!snapshot) return;
    const copied = await copyToClipboard(JSON.stringify(snapshot, null, 2), null);
    this.view.setButtonLabel(
      '[data-screen-copy-diagnostics]',
      copied ? 'labelDiagnosticsCopied' : 'labelDiagnosticsCopy'
    );
  }

  /** 録画は配信中だけ操作できる。MediaStream は live session から借りる。 */
  private toggleRecording(): Promise<void> {
    const live = this.live;
    return live ? this.recording.toggle(live.capture.media) : Promise.resolve();
  }

  private async extend(): Promise<void> {
    const live = this.live;
    if (!live || this.stopping) return;
    this.view.setBusy('[data-screen-extend]', true, 'labelExtend');
    this.view.setLiveError(null);
    try {
      const extended = await this.api.extend(live.id);
      if (!this.isActiveLive(live)) return;
      live.extendExpiresAt = extended.extendExpiresAt;
      live.publishToken = extended.publishToken;
      live.publishTokenExpiresAt = extended.publishTokenExpiresAt;
      live.publisher.setPublishToken(extended.publishToken);
      this.expiresBarTotalSeconds = durationUntil(live.extendExpiresAt, this.deps.now());
      this.updateClock();
    } catch (error) {
      if (!this.isActiveLive(live)) return;
      // サーバー側で終了済みの配信は延長も継続もできない。録画の完了を待ってから
      // このブラウザの capture と PeerConnection も閉じ、終了理由を error 画面で伝える。
      if (isStreamEndedError(error)) return void await this.finishLocally('error', error);
      this.view.setLiveError(messageKeyForError(error));
    } finally {
      this.view.setBusy('[data-screen-extend]', false, 'labelExtend');
    }
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
        this.markLiveSuccess();
        this.view.setUrl(live.streamUrl);
        this.view.show('live');
      } else {
        // 再接続しても映像が届かない。現 publisher の stats で分類する（旧値へフォールバックしない）。
        const stats = await live.publisher.videoStats();
        if (!this.isActiveLive(live)) return; // videoStats 待機中に停止されたら復活させない。
        this.recordStreamFailure('healthTimeout', stats, live.capture.media);
        this.showError(new StreamHealthError());
      }
    } catch (error) {
      if (!this.isActiveLive(live)) return;
      const stopped = await this.finishLocally('error', error);
      if (stopped) await this.notifyRemoteStop(stopped);
    } finally {
      this.view.setBusy('[data-screen-retry]', false, this.live ? 'labelReconnect' : 'labelRetry');
    }
  }

  private stop(): Promise<void> {
    return this.finishAndNotify('idle');
  }

  private async finishAndNotify(phase: 'idle' | 'error', error?: unknown): Promise<void> {
    const live = await this.finishLocally(phase, error);
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
    const live = this.live;
    if (!live) return;
    const now = this.deps.now();
    const remaining = secondsUntil(live.extendExpiresAt, now);
    this.view.updateClock(
      live.startedAt,
      now,
      remaining,
      isExpiryWarning(live.extendExpiresAt, now),
      this.expiresBarTotalSeconds
    );
    // cron の kick を待たず、期限ちょうどでこのブラウザの capture と PeerConnection を閉じる。
    if (remaining === 0) void this.stop();
  }

  private handleStartError(error: unknown, media: MediaStream | null): void {
    if (isUnauthorizedRequestError(error)) return this.view.show('login');
    const kind = startFailureKind(error);
    // stats は close 前に採取済み（verifyInitialStream）。ここでの publisher は既に閉じている。
    // 診断対象外のエラー（サーバー業務エラー等）では古い診断を残さずボタンを隠す。
    if (kind) this.recordStreamFailure(kind, this.lastVideoStats, media);
    else this.lastDiagnostic = null;
    this.showError(error);
  }

  /** live 表示に到達したら診断を捨てる（後続の別エラーで古い診断をコピーさせない）。 */
  private markLiveSuccess(): void {
    this.lastDiagnostic = null;
    this.view.setDiagnosticsButtonVisible(false);
    // 前回の配信で出した延長・録画の失敗文言を、新しい配信の画面へ持ち越さない。
    this.view.setLiveError(null);
    this.view.setRecordingError(null);
  }

  /**
   * 失敗を匿名報告し、コピー用の診断スナップショットを退避する。
   * 診断の失敗で失敗表示を壊さないよう、全体を握り潰す（テレメトリ優先で画面を壊さない）。
   */
  private recordStreamFailure(
    kind: StreamFailureKind,
    stats: VideoPublishStats | null,
    media: MediaStream | null
  ): void {
    try {
      const failureCode = classifyStreamFailure({ kind, stats, health: null });
      this.reportStreamFailure({ stage: 'stream', errorCode: failureCode });
      this.lastDiagnostic = buildStreamDiagnosticSnapshot({
        streamId: this.lastStreamId,
        at: new Date(this.deps.now()).toISOString(),
        userAgent: userAgentString(),
        displaySurface: displaySurfaceOf(media),
        video: videoSettingsOf(media),
        stats,
        health: null,
        failureCode,
      });
    } catch (error) {
      console.warn('Failed to record stream failure diagnostics', error);
    }
  }

  private handleRuntimeError(error: unknown): void {
    void this.finishAndNotify('error', error);
  }

  /**
   * 配信を終了する。MediaStream の所有者は配信 session なので、track を止める前に
   * 録画の完了（最後のチャンクの書き出しと一覧への追加）を待つ。
   */
  private async finishLocally(phase: 'idle' | 'error', error?: unknown): Promise<LiveStreamSession | null> {
    if (!this.beginFinish()) return null;
    if (this.recording.isActive) {
      // 待っている間は停止ボタンで進行中だと分かるようにする（最長 3 秒）。
      this.view.setBusy('[data-screen-stop]', true, 'labelStopping');
      await this.awaitRecordingStop();
      this.view.setBusy('[data-screen-stop]', false, 'labelStop');
    }
    return this.closeLocally(phase, error);
  }

  /** 停止を予約し、進行中の開始と heartbeat を無効化する。二重停止なら false。 */
  private beginFinish(): boolean {
    if (this.stopping) return false;
    this.stopping = true;
    this.startGeneration += 1;
    this.activeStart?.abortController.abort();
    return true;
  }

  /**
   * 録画の停止完了を待つ。MediaRecorder.onstop は非同期なので待つが、待ちきれない時は
   * 配信停止を止めない（録画は破棄せず、完了した時点で一覧へ積まれる）。
   */
  private async awaitRecordingStop(): Promise<void> {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = globalThis.setTimeout(resolve, RECORDING_STOP_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.recording.stop(), timeout]);
    } finally {
      if (timer !== undefined) globalThis.clearTimeout(timer);
    }
  }

  /** capture と PeerConnection を閉じ、画面を戻す。閉じた配信 session を返す。 */
  private closeLocally(phase: 'idle' | 'error', error?: unknown): LiveStreamSession | null {
    const run = this.activeStart;
    this.activeStart = null;
    const live = this.live;
    live?.abortController.abort();
    if (live) live.closeLocal();
    else run?.capture.dispose();
    this.live = null;
    // ランタイム/再接続エラーは分類しない診断対象外の経路なので、古い診断は残さない。
    if (phase === 'error') {
      this.lastDiagnostic = null;
      this.showError(error);
    } else this.view.show('idle');
    return live;
  }

  private stopForPageHide(): void {
    const run = this.activeStart;
    this.beginFinish();
    // pagehide は beacon を同期で送りきる必要があるため、録画は停止要求だけ出して待たない。
    if (this.recording.isActive) void this.recording.stop();
    const live = this.closeLocally('idle');
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
    // 前回の試行の診断値を持ち越さない（無関係な次の失敗で古い stream id をコピーさせない）。
    this.lastStreamId = null;
    this.lastVideoStats = null;
    this.lastDiagnostic = null;
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
    this.view.showError(
      messageKeyForError(error),
      Boolean(this.live),
      isStreamAlreadyLiveError(error),
      retryAfterSecondsForError(error)
    );
    // 診断スナップショットがある失敗（配信の映像/接続系）でだけコピーボタンを出す。
    this.view.setDiagnosticsButtonVisible(this.lastDiagnostic !== null);
  }

  private search(): string {
    return this.deps.search?.() ?? currentSearch();
  }
}

/**
 * 開始時の例外を診断の失敗種別へ写す。報告すべきでない失敗（サーバー側の業務エラー
 * = capacity・already-live 等の JsonRequestError）は null を返して報告しない。
 */
function startFailureKind(error: unknown): StreamFailureKind | null {
  if (error instanceof StreamHealthError) return 'healthTimeout';
  if (error instanceof WhipPublishError) return 'publishFailed';
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return 'displayDenied';
  }
  return null;
}
