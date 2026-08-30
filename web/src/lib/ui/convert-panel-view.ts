import { MAX_CAPTURE_IMAGES } from '../contracts/api';
import type { ProgressStage, UploadErrorCode, UploadState } from './upload-flow';

/** 同じ表示項目が状態別ブロックに複数あるため、書き換えは全件に適用する。 */
function elements<T extends HTMLElement>(root: HTMLElement, selector: string): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

function errorMessage(panel: HTMLElement, code: UploadErrorCode, estimatedImages: number | null): string {
  if (code === 'pageTooLong') return pageTooLongMessage(panel, estimatedImages);

  const messages: Record<UploadErrorCode, string | undefined> = {
    tooLarge: panel.dataset['msgTooLarge'],
    unsupported: panel.dataset['msgUnsupported'],
    tooManyPages: panel.dataset['msgTooManyPages'],
    // pageTooLong は上の早期 return が組み立てるのでここは使わない（網羅性のために残す）。
    pageTooLong: panel.dataset['msgPageTooLong'],
    captureTimeout: panel.dataset['msgCaptureTimeout'],
    sessionExpired: panel.dataset['msgSessionExpired'],
    failed: panel.dataset['msgFailed'],
    pdfUrlNotSupported: panel.dataset['msgPdfUrlNotSupported'],
    imageUrlNotSupported: panel.dataset['msgImageUrlNotSupported'],
    videoUrlNotSupported: panel.dataset['msgVideoUrlNotSupported'],
    nonWebPageUrl: panel.dataset['msgNonWebPageUrl'],
    wasmLoadTimeout: panel.dataset['msgWasmLoadTimeout'],
    imageFetchTimeout: panel.dataset['msgImageFetchTimeout'],
    uploadTimeout: panel.dataset['msgUploadTimeout'],
    apiTimeout: panel.dataset['msgApiTimeout'],
  };
  return messages[code] ?? '';
}

/**
 * 「ページが長すぎる」文言を組み立てる。
 *
 * 上限（`{max}`）は契約定数から差し込むので辞書に数値を書かない。推定画面数が分かった時だけ
 * 「約 N 画面」を含む別の文言へ差し替える（1 つの文言を条件付きで削るより、辞書を読めば
 * 出る文が分かる方が翻訳しやすい）。
 */
function pageTooLongMessage(panel: HTMLElement, estimatedImages: number | null): string {
  // 上限以下の推定値は「長すぎる」と噛み合わない（上流の不整合・改変）。数を出さない文言へ倒す。
  const overLimit = estimatedImages !== null && estimatedImages > MAX_CAPTURE_IMAGES;
  const template =
    (overLimit ? panel.dataset['msgPageTooLongEstimated'] : undefined) ??
    panel.dataset['msgPageTooLong'] ??
    '';
  return template
    .replaceAll('{estimated}', overLimit ? String(estimatedImages) : '')
    .replaceAll('{max}', String(MAX_CAPTURE_IMAGES));
}

/** 段階名は辞書から data 属性で渡ってくる（文言をコードに直書きしないため）。 */
const STAGE_LABEL_KEYS: Readonly<Record<ProgressStage, string>> = {
  capturing: 'labelCapturing',
  preparing: 'labelPreparing',
  encoding: 'labelEncoding',
  uploading: 'labelUploading',
};

function stageLabel(panel: HTMLElement, state: UploadState): string {
  if (state.stage === null) return '';
  return panel.dataset[STAGE_LABEL_KEYS[state.stage]] ?? '';
}

/** URL 変換では表示するのがファイル名ではなく URL なので、見出し語も切り替える。 */
function sourceLabel(panel: HTMLElement, state: UploadState): string {
  if (state.kind === 'web') return panel.dataset['labelSourceUrl'] ?? '';
  return panel.dataset['labelSelectedFile'] ?? '';
}

/** 変換状態をパネル内の重複した状態表示へ反映する。 */
export function renderConvertPanel(panel: HTMLElement, state: UploadState): void {
  panel.dataset['phase'] = state.phase;

  for (const node of elements(panel, '[data-stage-label]')) node.textContent = stageLabel(panel, state);
  for (const node of elements(panel, '[data-source-label]')) node.textContent = sourceLabel(panel, state);
  for (const node of elements(panel, '[data-source-name]')) node.textContent = state.source ?? '';

  for (const bar of elements(panel, '[data-progress-bar]')) {
    bar.style.width = `${state.progress}%`;
    bar.setAttribute('aria-valuenow', String(state.progress));
  }
  for (const node of elements(panel, '[data-progress-value]')) node.textContent = `${state.progress}%`;

  const count = state.current !== null && state.total !== null ? `${state.current}/${state.total}` : '';
  for (const node of elements(panel, '[data-progress-count]')) node.textContent = count;

  const message = state.errorCode
    ? errorMessage(panel, state.errorCode, state.errorEstimatedImages)
    : '';
  for (const node of elements(panel, '[data-file-error-message]')) node.textContent = message;
  for (const node of elements(panel, '[data-url-error-message]')) node.textContent = message;
  for (const node of elements(panel, '[data-file-error]')) {
    node.hidden = state.errorTarget !== 'file' || message.length === 0;
  }
  for (const node of elements(panel, '[data-url-error]')) {
    node.hidden = state.errorTarget !== 'url' || message.length === 0;
  }
}
