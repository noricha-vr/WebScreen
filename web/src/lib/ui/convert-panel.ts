/**
 * 変換パネルの DOM 配線。状態の遷移規則は upload-flow.ts（純粋関数）が持ち、
 * ここは「イベントを流す」「状態を DOM に反映する」だけを担当する。
 *
 * 変換・アップロードの実処理は後続タスクが接続する。現時点では runDemo が
 * タイマーで進捗を進めるだけで、通信は一切行わない（画面には demoNotice を出す）。
 * 接続時は runDemo を実処理に差し替えれば済むよう、進捗の入力口を dispatch に寄せている。
 */

import { generateShortId, movieKey } from '../contracts/r2key';
import {
  INITIAL_UPLOAD_STATE,
  reduceUpload,
  type UploadErrorCode,
  type UploadEvent,
  type UploadState,
} from './upload-flow';

/** デモ遷移の 1 ステップ。Playwright の待ち時間が伸びない程度に短くする。 */
const DEMO_STEP_MS = 180;
const DEMO_PROGRESS_STEPS = [30, 65, 100] as const;
const COPIED_FEEDBACK_MS = 2000;

type Schedule = (callback: () => void, delayMs: number) => void;

export interface ConvertPanelOptions {
  schedule?: Schedule;
}

function element<T extends HTMLElement>(root: HTMLElement, selector: string): T | null {
  return root.querySelector<T>(selector);
}

/** 同じ表示項目が状態別ブロックに複数あるため、書き換えは全件に適用する。 */
function elements<T extends HTMLElement>(root: HTMLElement, selector: string): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

function errorMessage(panel: HTMLElement, code: UploadErrorCode): string {
  const messages: Record<UploadErrorCode, string | undefined> = {
    tooLarge: panel.dataset['msgTooLarge'],
    unsupported: panel.dataset['msgUnsupported'],
    failed: panel.dataset['msgFailed'],
  };
  return messages[code] ?? '';
}

function phaseLabel(panel: HTMLElement, state: UploadState): string {
  if (state.phase === 'converting') return panel.dataset['labelConverting'] ?? '';
  if (state.phase === 'uploading') return panel.dataset['labelUploading'] ?? '';
  if (state.phase === 'done') return panel.dataset['labelDone'] ?? '';
  return '';
}

function render(panel: HTMLElement, state: UploadState): void {
  panel.dataset['phase'] = state.phase;

  const label = phaseLabel(panel, state);
  for (const node of elements(panel, '[data-phase-label]')) node.textContent = label;

  for (const node of elements(panel, '[data-source-name]')) node.textContent = state.source ?? '';

  for (const bar of elements(panel, '[data-progress-bar]')) {
    bar.style.width = `${state.progress}%`;
    bar.setAttribute('aria-valuenow', String(state.progress));
  }

  for (const node of elements(panel, '[data-progress-value]')) {
    node.textContent = `${state.progress}%`;
  }

  for (const node of elements<HTMLInputElement>(panel, '[data-result-url]')) {
    node.value = state.publicUrl ?? '';
  }

  const message = state.errorCode ? errorMessage(panel, state.errorCode) : '';
  for (const node of elements(panel, '[data-error-message]')) node.textContent = message;
}

/** 実処理が繋がるまでの見た目確認用ドライバ。通信せずタイマーだけで進捗を進める。 */
function runDemo(dispatch: (event: UploadEvent) => void, schedule: Schedule): void {
  let step = 0;
  const queue: UploadEvent[] = [
    ...DEMO_PROGRESS_STEPS.map((value): UploadEvent => ({ type: 'progress', value })),
    { type: 'converted' },
    ...DEMO_PROGRESS_STEPS.map((value): UploadEvent => ({ type: 'progress', value })),
    { type: 'uploaded', publicUrl: `${location.origin}/${movieKey(generateShortId())}` },
  ];

  const tick = (): void => {
    const event = queue[step];
    if (!event) return;
    step += 1;
    dispatch(event);
    schedule(tick, DEMO_STEP_MS);
  };

  schedule(tick, DEMO_STEP_MS);
}

async function copyToClipboard(value: string, input: HTMLInputElement | null): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    // クリップボード権限が無い環境では選択状態にして手動コピーへ誘導する
    input?.select();
  }
}

export function mountConvertPanel(panel: HTMLElement, options: ConvertPanelOptions = {}): void {
  const schedule: Schedule =
    options.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));

  let state = INITIAL_UPLOAD_STATE;
  let generation = 0;

  const dispatch = (event: UploadEvent, runGeneration = generation): void => {
    if (runGeneration !== generation) return;

    const next = reduceUpload(state, event);
    if (next === state) return;

    const started = state.phase !== 'converting' && next.phase === 'converting';
    state = next;
    render(panel, state);

    if (started) {
      const current = generation;
      runDemo((demoEvent) => dispatch(demoEvent, current), schedule);
    }
  };

  const reset = (): void => {
    generation += 1;
    state = INITIAL_UPLOAD_STATE;
    render(panel, state);
  };

  const fileInput = element<HTMLInputElement>(panel, '[data-file-input]');
  fileInput?.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    dispatch({ type: 'selectFile', filename: file.name, sizeBytes: file.size });
    fileInput.value = '';
  });

  // クリックでのファイル選択は <label> と <input> の標準動作に任せる（JS で click() を
  // 足すとダイアログが二重に開く）。ここではドラッグ&ドロップだけを補う。
  const dropzone = element(panel, '[data-dropzone]');
  if (dropzone) {
    dropzone.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropzone.dataset['dragover'] = 'true';
    });
    dropzone.addEventListener('dragleave', () => {
      delete dropzone.dataset['dragover'];
    });
    dropzone.addEventListener('drop', (event) => {
      event.preventDefault();
      delete dropzone.dataset['dragover'];

      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      dispatch({ type: 'selectFile', filename: file.name, sizeBytes: file.size });
    });
  }

  const urlForm = element<HTMLFormElement>(panel, '[data-url-form]');
  urlForm?.addEventListener('submit', (event) => {
    event.preventDefault();

    const input = element<HTMLInputElement>(panel, '[data-url-input]');
    const url = input?.value.trim();
    if (!url) return;
    dispatch({ type: 'selectUrl', url });
  });

  const copyButton = element<HTMLButtonElement>(panel, '[data-copy-button]');
  copyButton?.addEventListener('click', () => {
    const input = element<HTMLInputElement>(panel, '[data-result-url]');
    void copyToClipboard(state.publicUrl ?? '', input);

    panel.dataset['copied'] = 'true';
    schedule(() => {
      delete panel.dataset['copied'];
    }, COPIED_FEEDBACK_MS);
  });

  element(panel, '[data-reset-button]')?.addEventListener('click', reset);

  render(panel, state);
}
