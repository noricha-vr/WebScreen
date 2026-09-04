import { ERROR_CODES } from '../../contracts/api';
import { JsonRequestError } from '../request-json';
import { WhipPublishError } from '../whip-publisher';
import type { PreviewPreferenceStore } from './preview-preference';
import type { LocalRecording, RecorderErrorCode, RecorderState } from './recorder';

export type ScreenSharePhase = 'idle' | 'login' | 'starting' | 'live' | 'error';

/** ダウンロード後に「保存しました」を出しておく時間。 */
const SAVED_LABEL_MS = 2400;
const BYTES_PER_MEGABYTE = 1024 * 1024;

export class StreamHealthError extends Error {}

/** 実装例外を i18n data key へ限定して変換する。 */
export function messageKeyForError(error: unknown): string {
  if (error instanceof WhipPublishError) {
    return error.code === 'H264_UNAVAILABLE' ? 'msgH264' : 'msgWhip';
  }
  if (error instanceof JsonRequestError) {
    if (error.errorCode === ERROR_CODES.streamAlreadyLive) return 'msgStreamAlreadyLive';
    if (error.errorCode === ERROR_CODES.streamIdNotReusable) {
      return error.retryAfterSeconds === null ? 'msgStreamIdNotReusable' : 'msgStreamIdReusableAfter';
    }
    if (error.errorCode === ERROR_CODES.streamCapacityReached) return 'msgStreamCapacity';
    if (error.errorCode === ERROR_CODES.streamCreateRateLimited) return 'msgRateLimited';
    if (error.errorCode === ERROR_CODES.streamExtensionDisabled) return 'msgStreamExtensionDisabled';
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

/** 固定 ID の再利用が拒否されたエラーか判定する。 */
export function isStreamIdNotReusableError(error: unknown): boolean {
  return error instanceof JsonRequestError && error.errorCode === ERROR_CODES.streamIdNotReusable;
}

/** 再利用待ちの秒数だけを、表示用に取り出す。 */
export function retryAfterSecondsForError(error: unknown): number | null {
  return error instanceof JsonRequestError ? error.retryAfterSeconds : null;
}

/** 画面共有カードの selector・表示状態・ラベル更新を所有する。 */
export class ScreenShareView {
  constructor(
    private readonly root: HTMLElement,
    private readonly previewPreference: PreviewPreferenceStore
  ) {}

  onClick(selector: string, listener: () => void): void {
    this.button(selector)?.addEventListener('click', listener);
  }

  show(phase: ScreenSharePhase): void {
    for (const step of this.root.querySelectorAll<HTMLElement>('[data-screen-step]')) {
      step.hidden = step.dataset['screenStep'] !== phase;
    }
    for (const item of this.root.querySelectorAll<HTMLElement>('[data-screen-flow-item]')) {
      const position = item.dataset['screenFlowItem'];
      item.dataset['state'] = phase === 'live' || phase === 'starting'
        ? position === '1' ? 'done' : position === '2' ? 'current' : 'todo'
        : position === '1' ? 'current' : 'todo';
    }
    if (phase === 'live') this.setPreviewOpen(this.previewPreference.load() ?? true);
  }

  showError(
    messageKey: string,
    hasLive: boolean,
    canStopOthers: boolean,
    retryAfterSeconds: number | null = null
  ): void {
    this.text('[data-screen-error-message]', this.message(messageKey, retryAfterSeconds));
    this.setButtonLabel('[data-screen-retry]', hasLive ? 'labelReconnect' : 'labelRetry');
    const stopOthers = this.button('[data-screen-stop-others]');
    if (stopOthers) {
      stopOthers.hidden = !canStopOthers;
      stopOthers.disabled = false;
      this.setButtonLabel('[data-screen-stop-others]', 'labelStopOthers');
    }
    // 他配信の停止が唯一の正しい操作の時は、同じ失敗を繰り返す再試行を出さない。
    const retry = this.button('[data-screen-retry]');
    if (retry) retry.hidden = canStopOthers;
    this.show('error');
  }

  /** 診断コピーボタンの表示切替。表示時はラベルを初期状態へ戻す。 */
  setDiagnosticsButtonVisible(visible: boolean): void {
    const button = this.button('[data-screen-copy-diagnostics]');
    if (!button) return;
    button.hidden = !visible;
    if (visible) this.setButtonLabel('[data-screen-copy-diagnostics]', 'labelDiagnosticsCopy');
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

  togglePreview(): void {
    const toggle = this.button('[data-screen-preview-toggle]');
    if (!toggle) return;
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    this.setPreviewOpen(open);
    this.previewPreference.save(open);
  }

  /** 配信を止めずに、延長などの操作エラーを配信中パネルへ表示する。 */
  setLiveError(messageKey: string | null): void {
    const error = this.root.querySelector<HTMLElement>('[data-screen-live-error]');
    if (!error) return;
    error.hidden = messageKey === null;
    if (messageKey !== null) error.textContent = this.message(messageKey);
  }

  /** 録画操作に対応して、トグルと REC チップを更新する。 */
  setRecordingState(state: RecorderState): void {
    const recording = state === 'recording';
    const button = this.button('[data-screen-record]');
    if (button) {
      button.dataset['recording'] = String(recording);
      button.setAttribute('aria-pressed', String(recording));
      button.disabled = state === 'stopping';
      this.setButtonLabel('[data-screen-record]', recording ? 'labelRecordStop' : 'labelRecordStart');
    }
    const icon = this.root.querySelector<HTMLElement>('[data-screen-record-icon]');
    if (icon) icon.className = recording ? 'fa-solid fa-stop' : 'fa-solid fa-circle-dot';
    const timer = this.root.querySelector<HTMLElement>('[data-screen-record-timer]');
    if (timer) timer.hidden = !recording;
  }

  /** REC 経過時間を表示する。 */
  setRecordingElapsed(seconds: number): void {
    this.text('[data-screen-record-elapsed]', formatDuration(seconds));
  }

  /** 録画エラーを配信中パネルへ表示する。 */
  setRecordingError(code: RecorderErrorCode | null): void {
    const error = this.root.querySelector<HTMLElement>('[data-screen-record-error]');
    if (!error) return;
    error.hidden = code === null;
    if (code !== null) error.textContent = this.message(`msgRecord${capitalize(code)}`);
  }

  /** ローカライズ済みの録画ファイル名の基底を返す。 */
  recordingFilenameBase(number: number): string {
    return this.message('recordFilenameBase').replace('{number}', String(number));
  }

  /** 完了した録画の一覧行とダウンロード操作を追加する。 */
  addRecording(recording: LocalRecording, number: number): void {
    const list = this.root.querySelector<HTMLUListElement>('[data-screen-record-list]');
    if (!list) return;
    const empty = this.root.querySelector<HTMLElement>('[data-screen-record-empty]');
    const item = document.createElement('li');
    item.className = 'flex flex-wrap items-center justify-between gap-2.5 rounded-[10px] border border-slate-200 bg-white px-3.5 py-3';
    const info = document.createElement('div');
    info.className = 'flex min-w-0 items-center gap-3';
    const badge = document.createElement('span');
    badge.className = 'inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg bg-brand-50 text-[13px] font-bold text-brand-700';
    badge.textContent = String(number);
    const meta = document.createElement('div');
    const name = document.createElement('p');
    name.className = 'm-0 text-sm font-bold text-slate-900';
    name.textContent = recording.filename;
    const details = document.createElement('p');
    details.className = 'mt-0.5 text-xs text-slate-500';
    details.textContent = this.message('recordDetails')
      .replace('{time}', new Date(recording.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      .replace('{duration}', formatDuration(recording.durationSeconds))
      .replace('{size}', (recording.sizeBytes / BYTES_PER_MEGABYTE).toFixed(1));
    meta.append(name, details);
    info.append(badge, meta);
    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'inline-flex items-center gap-1.5 rounded-full border border-brand-200 bg-white px-3.5 py-1.5 text-[13px] font-bold text-brand-700 hover:bg-brand-50';
    const downloadIcon = document.createElement('i');
    downloadIcon.className = 'fa-solid fa-download';
    downloadIcon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = this.message('labelRecordDownload');
    download.append(downloadIcon, label);
    download.addEventListener('click', () => void this.downloadRecording(recording, download));
    item.append(info, download);
    list.prepend(item);
    list.hidden = false;
    if (empty) empty.hidden = true;
  }

  setUrl(url: string): void {
    const input = this.root.querySelector<HTMLInputElement>('[data-screen-url]');
    if (input) input.value = url;
  }

  urlInput(): HTMLInputElement | null {
    return this.root.querySelector<HTMLInputElement>('[data-screen-url]');
  }

  setAudioStatus(media: MediaStream): void {
    const hasAudio = media.getAudioTracks().length > 0;
    const key = hasAudio ? 'msgAudioIncluded' : 'msgVideoOnly';
    this.text('[data-screen-audio-status]', this.message(key));
    const chip = this.root.querySelector<HTMLElement>('[data-screen-audio-chip]');
    if (chip) chip.dataset['audio'] = hasAudio ? 'on' : 'off';
    const icon = this.root.querySelector<HTMLElement>('[data-screen-audio-icon]');
    if (icon) icon.className = hasAudio ? 'fa-solid fa-volume-high' : 'fa-solid fa-volume-xmark';
    this.text('[data-screen-audio-label]', this.message(hasAudio ? 'audioOn' : 'audioOff'));
  }

  updateClock(
    startedAt: string,
    now: number,
    remaining: number,
    expiryWarning: boolean,
    expiresBarTotalSeconds = 0
  ): void {
    this.text('[data-screen-elapsed]', formatDuration((now - Date.parse(startedAt)) / 1000));
    this.text('[data-screen-expires]', formatDuration(remaining));
    const warning = this.root.querySelector<HTMLElement>('[data-screen-expiry-warning]');
    if (warning) warning.hidden = !expiryWarning;
    const expiresBar = this.root.querySelector<HTMLElement>('[data-screen-expires-bar]');
    if (expiresBar) {
      const width = expiresBarTotalSeconds === 0
        ? 0
        : Math.min(100, (remaining / expiresBarTotalSeconds) * 100);
      expiresBar.style.width = `${width}%`;
      expiresBar.dataset['warning'] = String(expiryWarning);
    }
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

  message(key: string, retryAfterSeconds: number | null = null): string {
    const message = this.root.dataset[key] ?? '';
    if (retryAfterSeconds === null) return message;
    return message.replace('{minutes}', String(Math.ceil(retryAfterSeconds / 60)));
  }

  private text(selector: string, value: string): void {
    const element = this.root.querySelector<HTMLElement>(selector);
    if (element) element.textContent = value;
  }

  private button(selector: string): HTMLButtonElement | null {
    return this.root.querySelector<HTMLButtonElement>(selector);
  }

  private setPreviewOpen(open: boolean): void {
    const value = String(open);
    const toggle = this.button('[data-screen-preview-toggle]');
    if (toggle) toggle.setAttribute('aria-expanded', value);
    for (const selector of [
      '[data-screen-preview-body]',
      '[data-screen-switch-track]',
      '[data-screen-switch-knob]',
    ]) {
      const element = this.root.querySelector<HTMLElement>(selector);
      if (element) element.dataset['open'] = value;
    }
    // 閉じている間はデコードと描画を止めて PC の負荷を下げる。MediaStream と WHIP には触れない。
    const video = this.root.querySelector<HTMLVideoElement>('[data-screen-preview]');
    if (video) {
      if (open) void video.play();
      else video.pause();
    }
  }

  private async downloadRecording(recording: LocalRecording, button: HTMLButtonElement): Promise<void> {
    try {
      const blob = recording.blob ?? await recording.fileHandle?.getFile();
      if (!blob) throw new Error('Recording file is unavailable');
      const url = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = recording.filename;
        anchor.click();
      } finally {
        // click() 直後の同期 revoke はダウンロードを中断させるブラウザがあるため次タスクへ回す。
        globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      const label = button.querySelector('span');
      if (label) label.textContent = this.message('labelRecordSaved');
      button.dataset['saved'] = 'true';
      globalThis.setTimeout(() => {
        button.dataset['saved'] = 'false';
        const label = button.querySelector('span');
        if (label) label.textContent = this.message('labelRecordDownload');
      }, SAVED_LABEL_MS);
    } catch {
      this.setRecordingError('writeFailed');
    }
  }
}

function formatDuration(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(rounded / 60);
  return `${minutes}:${String(rounded % 60).padStart(2, '0')}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
