import { ERROR_CODES } from '../../contracts/api';
import { JsonRequestError } from '../request-json';
import { WhipPublishError } from '../whip-publisher';

export type ScreenSharePhase = 'idle' | 'login' | 'url' | 'live' | 'error';

export class StreamHealthError extends Error {}

/** 配信 URL 確認カードの次に進める段階を返す。 */
export function nextStreamStep(phase: 'url' | 'live'): 'live' | null {
  return phase === 'url' ? 'live' : null;
}

/** 実装例外を i18n data key へ限定して変換する。 */
export function messageKeyForError(error: unknown): string {
  if (error instanceof WhipPublishError) {
    return error.code === 'H264_UNAVAILABLE' ? 'msgH264' : 'msgWhip';
  }
  if (error instanceof JsonRequestError) {
    if (error.errorCode === ERROR_CODES.streamAlreadyLive) return 'msgStreamAlreadyLive';
    if (error.errorCode === ERROR_CODES.streamCapacityReached) return 'msgStreamCapacity';
    if (error.errorCode === ERROR_CODES.streamCreateRateLimited) return 'msgRateLimited';
    if (error.errorCode === ERROR_CODES.streamEnded) return 'msgStreamEnded';
  }
  if (error instanceof StreamHealthError) return 'msgStreamUnhealthy';
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return 'msgDisplayDenied';
  }
  return 'msgGeneric';
}

/** 別の live を明示停止できる競合エラーか判定する。 */
export function isStreamAlreadyLiveError(error: unknown): boolean {
  return error instanceof JsonRequestError && error.errorCode === ERROR_CODES.streamAlreadyLive;
}

/** 画面共有カードの selector・表示状態・ラベル更新を所有する。 */
export class ScreenShareView {
  constructor(private readonly root: HTMLElement) {}

  onClick(selector: string, listener: () => void): void {
    this.button(selector)?.addEventListener('click', listener);
  }

  show(phase: ScreenSharePhase): void {
    for (const step of this.root.querySelectorAll<HTMLElement>('[data-screen-step]')) {
      step.hidden = step.dataset['screenStep'] !== phase;
    }
    const active = phase === 'url' ? '1' : phase === 'live' ? '2' : null;
    const indicators = this.root.querySelector<HTMLElement>('[data-screen-indicators]');
    if (indicators) indicators.hidden = active === null;
    for (const indicator of this.root.querySelectorAll<HTMLElement>('[data-screen-indicator]')) {
      indicator.dataset['active'] = indicator.dataset['screenIndicator'] === active ? 'true' : 'false';
    }
  }

  showError(messageKey: string, hasLive: boolean, showStopOthers: boolean): void {
    this.text('[data-screen-error-message]', this.message(messageKey));
    this.setButtonLabel('[data-screen-retry]', hasLive ? 'labelReconnect' : 'labelRetry');
    const stopOthers = this.button('[data-screen-stop-others]');
    if (stopOthers) {
      stopOthers.hidden = !showStopOthers;
      stopOthers.disabled = false;
      this.setButtonLabel('[data-screen-stop-others]', 'labelStopOthers');
    }
    this.show('error');
  }

  /** stop-live完了待ちの文言だけを更新し、button状態を保持する。 */
  showStoppingOthers(): void {
    this.text('[data-screen-error-message]', this.message('labelStoppingOthers'));
    this.setButtonLabel('[data-screen-stop-others]', 'labelStoppingOthers');
  }

  setPreview(media: MediaStream): void {
    const video = this.root.querySelector<HTMLVideoElement>('[data-screen-preview]');
    if (video) video.srcObject = media;
  }

  setUrl(url: string): void {
    const input = this.root.querySelector<HTMLInputElement>('[data-screen-url]');
    if (input) input.value = url;
  }

  urlInput(): HTMLInputElement | null {
    return this.root.querySelector<HTMLInputElement>('[data-screen-url]');
  }

  setAudioStatus(media: MediaStream): void {
    const key = media.getAudioTracks().length > 0 ? 'msgAudioIncluded' : 'msgVideoOnly';
    this.text('[data-screen-audio-status]', this.message(key));
  }

  updateClock(startedAt: string, now: number, remaining: number, expiryWarning: boolean): void {
    this.text('[data-screen-elapsed]', formatDuration((now - Date.parse(startedAt)) / 1000));
    this.text('[data-screen-expires]', formatDuration(remaining));
    const warning = this.root.querySelector<HTMLElement>('[data-screen-expiry-warning]');
    if (warning) warning.hidden = !expiryWarning;
  }

  setBusy(selector: string, busy: boolean, label: string): void {
    const button = this.button(selector);
    if (!button) return;
    button.disabled = busy;
    this.setButtonLabel(selector, label);
  }

  setDisabled(selector: string, disabled: boolean): void {
    const button = this.button(selector);
    if (button) button.disabled = disabled;
  }

  setButtonLabel(selector: string, label: string): void {
    const button = this.button(selector);
    if (button) (button.querySelector('span') ?? button).textContent = this.message(label);
  }

  message(key: string): string {
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

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, '0')}`;
}
