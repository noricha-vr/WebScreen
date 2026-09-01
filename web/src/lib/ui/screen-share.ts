import { ERROR_CODES, type CreateStreamResponse, type ExtendStreamResponse } from '../contracts/api';
import { copyToClipboard } from './clipboard';
import { isUnauthorizedRequestError, JsonRequestError, requestJson } from './request-json';
import { startWhipPublisher, WhipPublishError, type WhipPublisher } from './whip-publisher';

export const HEARTBEAT_INTERVAL_MS = 25_000;
export const EXPIRY_WARNING_SECONDS = 5 * 60;

type ScreenSharePhase = 'idle' | 'select' | 'login' | 'url' | 'live' | 'error';
type LiveStream = CreateStreamResponse & { publisher: WhipPublisher; media: MediaStream };

/** DOM controller の外部境界。テストでは画面・API・WHIP を独立して差し替える。 */
export interface ScreenShareDependencies {
  requestJson: typeof requestJson;
  startWhipPublisher: typeof startWhipPublisher;
  getDisplayMedia: typeof navigator.mediaDevices.getDisplayMedia;
  now: () => number;
}

const DEFAULT_DEPENDENCIES: ScreenShareDependencies = {
  requestJson,
  startWhipPublisher,
  getDisplayMedia: (constraints) => navigator.mediaDevices.getDisplayMedia(constraints),
  now: () => Date.now(),
};

/** ローカル配信を停止し、WHIP DELETE の成否を呼び出し元へ返す。 */
export async function releaseScreenShare(
  live: Pick<LiveStream, 'publisher' | 'media'>,
  clearTimers: () => void
): Promise<unknown | null> {
  let closeError: unknown = null;
  try {
    await live.publisher.close();
  } catch (error) {
    closeError = error;
  } finally {
    stopMedia(live.media);
    clearTimers();
  }
  return closeError;
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

  constructor(
    private readonly root: HTMLElement,
    private readonly deps: ScreenShareDependencies = DEFAULT_DEPENDENCIES
  ) {}

  mount(): void {
    this.button('[data-screen-start]')?.addEventListener('click', () => this.show('select'));
    this.button('[data-screen-select]')?.addEventListener('click', () => void this.selectScreen());
    this.button('[data-screen-copy]')?.addEventListener('click', () => void this.copyUrl());
    this.button('[data-screen-show-live]')?.addEventListener('click', () => this.show(nextStreamStep('url') ?? 'live'));
    this.button('[data-screen-extend]')?.addEventListener('click', () => void this.extend());
    this.button('[data-screen-stop]')?.addEventListener('click', () => void this.stop());
    this.button('[data-screen-retry]')?.addEventListener('click', () => this.show('select'));
    this.show('idle');
  }

  private async selectScreen(): Promise<void> {
    this.setBusy('[data-screen-select]', true, 'labelSelecting');
    try {
      const media = await this.deps.getDisplayMedia(displayMediaConstraints());
      const stream = await this.createAndPublish(media);
      this.live = stream;
      this.setUrl(stream.streamUrl);
      this.preview(stream.media);
      this.startTimers();
      stream.media.getVideoTracks()[0]?.addEventListener('ended', () => void this.stop());
      this.show('url');
    } catch (error) {
      this.handleStartError(error);
    } finally {
      this.setBusy('[data-screen-select]', false, 'labelSelect');
    }
  }

  private async createAndPublish(media: MediaStream): Promise<LiveStream> {
    let created: CreateStreamResponse;
    try {
      created = asCreateStream(await this.deps.requestJson('/api/streams/', { method: 'POST' }));
    } catch (error) {
      stopMedia(media);
      throw error;
    }
    try {
      const publisher = await this.deps.startWhipPublisher({
        stream: media,
        streamId: created.id,
        publishToken: created.publishToken,
      });
      return { ...created, publisher, media };
    } catch (error) {
      stopMedia(media);
      await this.deps.requestJson(`/api/streams/${encodeURIComponent(created.id)}/stop/`, { method: 'POST' });
      throw error;
    }
  }

  private async copyUrl(): Promise<void> {
    const input = this.root.querySelector<HTMLInputElement>('[data-screen-url]');
    if (!input) return;
    const copied = await copyToClipboard(input.value, input);
    this.setButtonLabel('[data-screen-copy]', copied ? 'labelCopied' : 'labelCopy');
  }

  private async extend(): Promise<void> {
    if (!this.live) return;
    this.setBusy('[data-screen-extend]', true, 'labelExtending');
    try {
      const response = asExtendStream(
        await this.deps.requestJson(`/api/streams/${encodeURIComponent(this.live.id)}/extend/`, { method: 'POST' })
      );
      this.live.extendExpiresAt = response.extendExpiresAt;
      this.live.publishToken = response.publishToken;
      this.live.publisher.setPublishToken(response.publishToken);
      this.updateClock();
    } catch (error) {
      await this.handleRuntimeError(error);
    } finally {
      this.setBusy('[data-screen-extend]', false, 'labelExtend');
    }
  }

  private async stop(): Promise<void> {
    if (!this.live) return;
    const live = this.live;
    this.setBusy('[data-screen-stop]', true, 'labelStopping');
    try {
      await this.deps.requestJson(`/api/streams/${encodeURIComponent(live.id)}/stop/`, { method: 'POST' });
    } catch (error) {
      await this.handleRuntimeError(error);
      this.setBusy('[data-screen-stop]', false, 'labelStop');
      return;
    }

    const closeError = await releaseScreenShare(live, () => this.clearTimers());
    this.live = null;

    if (closeError) {
      this.showError(closeError);
    } else {
      this.show('idle');
    }
    this.setBusy('[data-screen-stop]', false, 'labelStop');
  }

  private startTimers(): void {
    this.clearTimers();
    this.updateClock();
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), HEARTBEAT_INTERVAL_MS);
    this.clockTimer = setInterval(() => this.updateClock(), 1_000);
  }

  private async heartbeat(): Promise<void> {
    if (!this.live) return;
    try {
      await this.deps.requestJson(`/api/streams/${encodeURIComponent(this.live.id)}/heartbeat/`, { method: 'POST' });
    } catch (error) {
      await this.handleRuntimeError(error);
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

  private async handleRuntimeError(error: unknown): Promise<void> {
    const live = this.live;
    this.live = null;
    if (live) await releaseScreenShare(live, () => this.clearTimers());
    else this.clearTimers();
    this.showError(error);
  }

  private showError(error: unknown): void {
    this.text('[data-screen-error-message]', this.messageFor(error));
    this.show('error');
  }

  private messageFor(error: unknown): string {
    if (error instanceof WhipPublishError) {
      return this.message(error.code === 'H264_UNAVAILABLE' ? 'msgH264' : 'msgWhip');
    }
    if (error instanceof JsonRequestError) {
      if (error.errorCode === ERROR_CODES.streamAlreadyLive) return this.message('msgStreamAlreadyLive');
      if (error.errorCode === ERROR_CODES.streamCreateRateLimited) return this.message('msgRateLimited');
      if (error.errorCode === ERROR_CODES.streamEnded) return this.message('msgStreamEnded');
    }
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
    const active = phase === 'url' ? 2 : phase === 'live' ? 3 : 1;
    for (const indicator of this.root.querySelectorAll<HTMLElement>('[data-screen-indicator]')) {
      indicator.dataset['active'] = indicator.dataset['screenIndicator'] === String(active) ? 'true' : 'false';
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

  private setBusy(selector: string, busy: boolean, label: string): void {
    const button = this.button(selector);
    if (!button) return;
    button.disabled = busy;
    this.setButtonLabel(selector, label);
  }

  private setButtonLabel(selector: string, label: string): void {
    const button = this.button(selector);
    if (button) button.textContent = this.message(label);
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

function displayMediaConstraints(): MediaStreamConstraints {
  return {
    // ピッカーは既定のまま（画面全体・ウィンドウ・タブから選ばせる）。PoC の
    // preferCurrentTab は macOS 権限回避用で、自タブ共有は製品では意味がない。
    // macOS の画面収録が未許可だと NotAllowedError になる（displayDenied 文言で案内）
    video: { width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false,
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stopMedia(media: MediaStream): void {
  for (const track of media.getTracks()) track.stop();
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(rounded / 60);
  const remaining = String(rounded % 60).padStart(2, '0');
  return `${minutes}:${remaining}`;
}
