/**
 * 変換パネルの DOM 配線。状態の遷移規則は upload-flow.ts（純粋関数）が持ち、
 * ここは「イベントを流す」「状態を DOM に反映する」だけを担当する。
 *
 * 変換とアップロードはここで順につなぎ、状態そのものは upload-flow.ts の純粋関数に委ねる。
 */

import {
  ERROR_CODES,
  MAX_UPLOAD_BYTES,
  type CaptureResponse,
  type CommitResponse,
  type ErrorCode,
  type PresignResponse,
  type UploadKind,
} from '../contracts/api';
import { isShortId } from '../contracts/r2key';
import { movieEndpoint } from './history-view';
import { ConversionError, convertFilesToMp4, convertImageUrlsToMp4 } from '../convert';
import {
  INITIAL_UPLOAD_STATE,
  preflightInputFiles,
  reduceUpload,
  type UploadErrorCode,
  type UploadEvent,
} from './upload-flow';
import { markAutoCopy } from './auto-copy';
import { movieNameForFiles, movieNameForUrl } from './upload-name';
import { renderConvertPanel } from './convert-panel-view';
import { isUnauthorizedRequestError, JsonRequestError, requestJson } from './request-json';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

/**
 * 予約だけ済んで実体が上がらなかった動画を取り消す。
 *
 * keepalive を付けるのは、タブを閉じる直前の失敗でも送信を試みるため。ここが
 * 失敗しても利用者に見せる情報は無い（cron の回収に委ねる）ので握りつぶす。
 */
function abandonUpload(shortId: string): void {
  try {
    void fetch(movieEndpoint(shortId), {
      method: 'DELETE',
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // 送信自体が組み立てられない場合も、変換失敗の表示を優先して無視する
  }
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

  // presign を通った時点で pending の行が予約されている。ここから先で失敗すると
  // 誰も failed へ落とさないまま残り、cron が回収するまで容量を占め続ける。
  // ただし取り消してよいのは「まだ ready になっていないと確信できる」失敗だけ。
  try {
    const upload = await fetch(presign.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body: mp4,
    });
    if (!upload.ok) throw new Error(`Upload failed: ${upload.status}`);
  } catch (error) {
    // R2 への PUT 段階の失敗。commit を送っていないので確実に pending のまま。
    abandonUpload(presign.shortId);
    throw error;
  }

  dispatch({ type: 'progress', value: 80 }, runGeneration);

  try {
    const committed = asCommitResponse(
      await requestJson('/api/uploads/commit/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shortId: presign.shortId }),
      })
    );
    dispatch({ type: 'uploaded', publicUrl: committed.publicUrl, shortId: committed.shortId }, runGeneration);
  } catch (error) {
    // サーバーが 4xx / 5xx を返した時だけ取り消す。通信断や、200 なのに本文が
    // 壊れている応答では commit が成功して ready になっている可能性があり、
    // 消すと完成した動画を失う（その場合の pending 残りは cron の回収に委ねる）。
    if (error instanceof JsonRequestError && error.status >= 400) {
      abandonUpload(presign.shortId);
    }
    throw error;
  }
}

const API_ERROR_TO_UPLOAD_ERROR: Readonly<Partial<Record<ErrorCode, UploadErrorCode>>> = {
  [ERROR_CODES.payloadTooLarge]: 'tooLarge',
  [ERROR_CODES.pageTooLong]: 'pageTooLong',
  [ERROR_CODES.captureTimeout]: 'captureTimeout',
  [ERROR_CODES.unauthorized]: 'sessionExpired',
  [ERROR_CODES.pdfUrlNotSupported]: 'pdfUrlNotSupported',
  [ERROR_CODES.imageUrlNotSupported]: 'imageUrlNotSupported',
  [ERROR_CODES.videoUrlNotSupported]: 'videoUrlNotSupported',
  [ERROR_CODES.nonWebPageUrl]: 'nonWebPageUrl',
};

/** API とブラウザ内変換の失敗を、辞書で表示できるエラーコードへ正規化する。 */
export function uploadErrorCode(error: unknown): UploadErrorCode {
  if (error instanceof ConversionError) {
    return error.code === 'tooManyPages' ? 'tooManyPages' : 'failed';
  }
  if (!(error instanceof JsonRequestError)) return 'failed';

  const mapped = error.errorCode
    ? API_ERROR_TO_UPLOAD_ERROR[error.errorCode as ErrorCode]
    : undefined;
  if (mapped) return mapped;
  return isUnauthorizedRequestError(error) ? 'sessionExpired' : 'failed';
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
    renderConvertPanel(panel, state);
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
    renderConvertPanel(panel, state);
  });

  const fileInput = element<HTMLInputElement>(panel, '[data-file-input]');
  const startFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    if (state.phase === 'converting' || state.phase === 'uploading') return;
    // 署名読み取り中に別の入力へ切り替わった場合、古い検証結果で状態を上書きしない。
    const current = ++generation;
    const preflight = await preflightInputFiles(files);
    if (current !== generation) return;
    if (!preflight.ok) {
      dispatch({ type: 'failed', errorCode: 'unsupported' }, current);
      return;
    }
    const event: UploadEvent = {
      type: 'selectFiles',
      files: files.map((file) => ({ filename: file.name, sizeBytes: file.size })),
    };
    const next = reduceUpload(state, event);
    dispatch(event, current);
    if (next.phase !== 'converting' || next.kind === null || next.kind === 'web' || next.kind !== preflight.kind) return;
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
        dispatch({ type: 'failed', errorCode: uploadErrorCode(error) }, current);
      });
  };
  fileInput?.addEventListener('change', () => {
    void startFiles(Array.from(fileInput.files ?? []));
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

      void startFiles(Array.from(event.dataTransfer?.files ?? []));
    });
  }

  const urlForm = element<HTMLFormElement>(panel, '[data-url-form]');
  urlForm?.addEventListener('submit', (event) => {
    event.preventDefault();

    const input = element<HTMLInputElement>(panel, '[data-url-input]');
    const url = input?.value.trim();
    if (!url) return;
    if (state.phase === 'converting' || state.phase === 'uploading') return;
    const current = ++generation;
    dispatch({ type: 'selectUrl', url }, current);

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
        dispatch({ type: 'failed', errorCode: uploadErrorCode(error), target: 'url' }, current);
      });
  });

  renderConvertPanel(panel, state);
}
