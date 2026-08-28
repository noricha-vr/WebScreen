import type { UploadErrorCode, UploadState } from './upload-flow';

/** 同じ表示項目が状態別ブロックに複数あるため、書き換えは全件に適用する。 */
function elements<T extends HTMLElement>(root: HTMLElement, selector: string): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

function errorMessage(panel: HTMLElement, code: UploadErrorCode): string {
  const messages: Record<UploadErrorCode, string | undefined> = {
    tooLarge: panel.dataset['msgTooLarge'],
    unsupported: panel.dataset['msgUnsupported'],
    tooManyPages: panel.dataset['msgTooManyPages'],
    pageTooLong: panel.dataset['msgPageTooLong'],
    captureTimeout: panel.dataset['msgCaptureTimeout'],
    sessionExpired: panel.dataset['msgSessionExpired'],
    failed: panel.dataset['msgFailed'],
    pdfUrlNotSupported: panel.dataset['msgPdfUrlNotSupported'],
    imageUrlNotSupported: panel.dataset['msgImageUrlNotSupported'],
    videoUrlNotSupported: panel.dataset['msgVideoUrlNotSupported'],
    nonWebPageUrl: panel.dataset['msgNonWebPageUrl'],
  };
  return messages[code] ?? '';
}

function phaseLabel(panel: HTMLElement, state: UploadState): string {
  if (state.phase === 'converting') return panel.dataset['labelConverting'] ?? '';
  if (state.phase === 'uploading') return panel.dataset['labelUploading'] ?? '';
  return '';
}

/** URL 変換では表示するのがファイル名ではなく URL なので、見出し語も切り替える。 */
function sourceLabel(panel: HTMLElement, state: UploadState): string {
  if (state.kind === 'web') return panel.dataset['labelSourceUrl'] ?? '';
  return panel.dataset['labelSelectedFile'] ?? '';
}

/** 変換状態をパネル内の重複した状態表示へ反映する。 */
export function renderConvertPanel(panel: HTMLElement, state: UploadState): void {
  panel.dataset['phase'] = state.phase;

  for (const node of elements(panel, '[data-phase-label]')) node.textContent = phaseLabel(panel, state);
  for (const node of elements(panel, '[data-source-label]')) node.textContent = sourceLabel(panel, state);
  for (const node of elements(panel, '[data-source-name]')) node.textContent = state.source ?? '';

  for (const bar of elements(panel, '[data-progress-bar]')) {
    bar.style.width = `${state.progress}%`;
    bar.setAttribute('aria-valuenow', String(state.progress));
  }
  for (const node of elements(panel, '[data-progress-value]')) node.textContent = `${state.progress}%`;

  const count = state.current !== null && state.total !== null ? `${state.current}/${state.total}` : '';
  for (const node of elements(panel, '[data-progress-count]')) node.textContent = count;

  const message = state.errorCode ? errorMessage(panel, state.errorCode) : '';
  for (const node of elements(panel, '[data-file-error-message]')) node.textContent = message;
  for (const node of elements(panel, '[data-url-error-message]')) node.textContent = message;
  for (const node of elements(panel, '[data-file-error]')) {
    node.hidden = state.errorTarget !== 'file' || message.length === 0;
  }
  for (const node of elements(panel, '[data-url-error]')) {
    node.hidden = state.errorTarget !== 'url' || message.length === 0;
  }
}
