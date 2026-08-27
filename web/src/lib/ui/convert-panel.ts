/**
 * 変換パネルの DOM 配線。状態の遷移規則は upload-flow.ts（純粋関数）が持ち、
 * ここは「イベントを流す」「状態を DOM に反映する」だけを担当する。
 *
 * 変換とアップロードはここで順につなぎ、状態そのものは upload-flow.ts の純粋関数に委ねる。
 */

import { MAX_UPLOAD_BYTES, type CaptureResponse, type CommitResponse, type PresignResponse, type UploadKind } from '../contracts/api';
import { isShortId } from '../contracts/r2key';
import { ConversionError, convertFilesToMp4, convertImageUrlsToMp4 } from '../convert';
import {
  INITIAL_UPLOAD_STATE,
  reduceUpload,
  type UploadErrorCode,
  type UploadEvent,
  type UploadState,
} from './upload-flow';
import { markAutoCopy } from './auto-copy';
import { movieNameForFiles, movieNameForUrl } from './upload-name';

/** data-batch-name-suffix が無いときの接尾辞（ロケール非依存で読める形）。 */
const DEFAULT_BATCH_NAME_SUFFIX = '+{count}';

/**
 * URL 変換のキャプチャ待ち（数十秒）は進捗イベントが一切来ないため、バーが 0% で静止する。
 * その間だけ疑似進捗をゆっくり進めて「動いている」ことを示す。実進捗を先取りしないよう
 * 上限は低く抑え、キャプチャ完了後は実進捗（conversionProgress）へ引き継ぐ。
 */
const CAPTURE_PSEUDO_PROGRESS_INTERVAL_MS = 800;
const CAPTURE_PSEUDO_PROGRESS_START = 2;
const CAPTURE_PSEUDO_PROGRESS_MAX = 12;

type Dispatch = (event: UploadEvent, runGeneration?: number) => void;
type Navigate = (url: string) => void;

export interface ConvertPanelOptions {
  navigate?: Navigate;
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
    tooManyPages: panel.dataset['msgTooManyPages'],
    failed: panel.dataset['msgFailed'],
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

function render(panel: HTMLElement, state: UploadState): void {
  panel.dataset['phase'] = state.phase;

  const label = phaseLabel(panel, state);
  for (const node of elements(panel, '[data-phase-label]')) node.textContent = label;

  const source = sourceLabel(panel, state);
  for (const node of elements(panel, '[data-source-label]')) node.textContent = source;

  for (const node of elements(panel, '[data-source-name]')) node.textContent = state.source ?? '';

  for (const bar of elements(panel, '[data-progress-bar]')) {
    bar.style.width = `${state.progress}%`;
    bar.setAttribute('aria-valuenow', String(state.progress));
  }

  for (const node of elements(panel, '[data-progress-value]')) {
    node.textContent = `${state.progress}%`;
  }

  const count = state.current !== null && state.total !== null ? `${state.current}/${state.total}` : '';
  for (const node of elements(panel, '[data-progress-count]')) node.textContent = count;

  const message = state.errorCode ? errorMessage(panel, state.errorCode) : '';
  for (const node of elements(panel, '[data-error-message]')) node.textContent = message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, credentials: 'same-origin' });
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

function asPresignResponse(value: unknown): PresignResponse {
  if (!isRecord(value) || typeof value.shortId !== 'string' || typeof value.uploadUrl !== 'string' || typeof value.publicUrl !== 'string') {
    throw new Error('Invalid presign response');
  }
  return { shortId: value.shortId, uploadUrl: value.uploadUrl, publicUrl: value.publicUrl };
}

function asCommitResponse(value: unknown): CommitResponse {
  if (
    !isRecord(value) ||
    typeof value.shortId !== 'string' ||
    !isShortId(value.shortId) ||
    typeof value.publicUrl !== 'string' ||
    typeof value.sizeBytes !== 'number' ||
    (typeof value.expiresAt !== 'string' && value.expiresAt !== null)
  ) {
    throw new Error('Invalid commit response');
  }
  return {
    shortId: value.shortId,
    publicUrl: value.publicUrl,
    sizeBytes: value.sizeBytes,
    expiresAt: value.expiresAt,
  };
}

function asCaptureResponse(value: unknown): CaptureResponse {
  if (!isRecord(value) || !Array.isArray(value.images) || value.images.some((image) => typeof image !== 'string')) {
    throw new Error('Invalid capture response');
  }
  return { images: value.images as string[] };
}

async function uploadMp4(
  mp4: Blob,
  filename: string,
  kind: UploadKind,
  dispatch: Dispatch,
  runGeneration: number
): Promise<void> {
  if (mp4.size > MAX_UPLOAD_BYTES) {
    dispatch({ type: 'failed', errorCode: 'tooLarge' }, runGeneration);
    return;
  }
  dispatch({ type: 'converted' }, runGeneration);
  const presign = asPresignResponse(
    await requestJson('/api/uploads/presign/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, sizeBytes: mp4.size, kind }),
    })
  );
  dispatch({ type: 'progress', value: 20 }, runGeneration);
  const upload = await fetch(presign.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4' },
    body: mp4,
  });
  if (!upload.ok) throw new Error(`Upload failed: ${upload.status}`);
  dispatch({ type: 'progress', value: 80 }, runGeneration);
  const committed = asCommitResponse(
    await requestJson('/api/uploads/commit/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortId: presign.shortId }),
    })
  );
  dispatch({ type: 'uploaded', publicUrl: committed.publicUrl, shortId: committed.shortId }, runGeneration);
}

function conversionErrorCode(error: unknown): UploadErrorCode {
  return error instanceof ConversionError && error.code === 'tooManyPages' ? 'tooManyPages' : 'failed';
}

export function mountConvertPanel(panel: HTMLElement, options: ConvertPanelOptions = {}): void {
  const navigate: Navigate = options.navigate ?? ((url) => window.location.assign(url));

  let state = INITIAL_UPLOAD_STATE;
  let generation = 0;

  const dispatch: Dispatch = (event, runGeneration = generation): void => {
    if (runGeneration !== generation) return;

    const next = reduceUpload(state, event);
    if (next === state) return;

    state = next;
    render(panel, state);
    if (next.phase === 'done' && next.shortId) {
      markAutoCopy(next.shortId);
      navigate(`/${next.shortId}/`);
    }
  };

  // BFCache で復元すると完了状態のままになるため、古い非同期処理も無効化して初期表示に戻す。
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    generation += 1;
    state = INITIAL_UPLOAD_STATE;
    render(panel, state);
  });

  const fileInput = element<HTMLInputElement>(panel, '[data-file-input]');
  const startFiles = (files: readonly File[]): void => {
    if (files.length === 0) return;
    if (state.phase === 'converting' || state.phase === 'uploading') return;
    const event: UploadEvent = {
      type: 'selectFiles',
      files: files.map((file) => ({ filename: file.name, sizeBytes: file.size })),
    };
    const next = reduceUpload(state, event);
    dispatch(event);
    if (next.phase !== 'converting' || next.kind === null || next.kind === 'web') return;
    const current = generation;
    const kind = next.kind;
    void convertFilesToMp4(files, kind, (progress) => {
      dispatch({ type: 'conversionProgress', ...progress }, current);
    })
      .then((mp4) =>
        uploadMp4(
          mp4,
          movieNameForFiles(
            files.map((file) => file.name),
            panel.dataset['batchNameSuffix'] ?? DEFAULT_BATCH_NAME_SUFFIX
          ),
          kind,
          dispatch,
          current
        )
      )
      .catch((error: unknown) => {
        console.error('conversion failed', error);
        dispatch({ type: 'failed', errorCode: conversionErrorCode(error) }, current);
      });
  };
  fileInput?.addEventListener('change', () => {
    startFiles(Array.from(fileInput.files ?? []));
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

      startFiles(Array.from(event.dataTransfer?.files ?? []));
    });
  }

  const urlForm = element<HTMLFormElement>(panel, '[data-url-form]');
  urlForm?.addEventListener('submit', (event) => {
    event.preventDefault();

    const input = element<HTMLInputElement>(panel, '[data-url-input]');
    const url = input?.value.trim();
    if (!url) return;
    if (state.phase === 'converting' || state.phase === 'uploading') return;
    dispatch({ type: 'selectUrl', url });
    const current = generation;

    let pseudoProgress = CAPTURE_PSEUDO_PROGRESS_START - 1;
    const pseudoTimer = window.setInterval(() => {
      pseudoProgress += 1;
      dispatch({ type: 'progress', value: pseudoProgress }, current);
      if (pseudoProgress >= CAPTURE_PSEUDO_PROGRESS_MAX) window.clearInterval(pseudoTimer);
    }, CAPTURE_PSEUDO_PROGRESS_INTERVAL_MS);

    void requestJson('/api/capture/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    })
      .then(asCaptureResponse)
      // 成功・失敗のどちらでも疑似進捗を必ず止める（ここから先は実進捗が来る）。
      .finally(() => {
        window.clearInterval(pseudoTimer);
      })
      .then((capture) => convertImageUrlsToMp4(capture.images, (progress) => {
        dispatch({ type: 'conversionProgress', ...progress }, current);
      }))
      .then((mp4) => uploadMp4(mp4, movieNameForUrl(url), 'web', dispatch, current))
      .catch((error: unknown) => {
        console.error('conversion failed', error);
        dispatch({ type: 'failed', errorCode: conversionErrorCode(error) }, current);
      });
  });

  render(panel, state);
}
