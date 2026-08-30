/**
 * 変換パネルの DOM 配線。状態の遷移規則は upload-flow.ts（純粋関数）が持ち、
 * ここは「イベントを流す」「状態を DOM に反映する」だけを担当する。
 *
 * 変換とアップロードはここで順につなぎ、状態そのものは upload-flow.ts の純粋関数に委ねる。
 */

import {
  ERROR_CODES,
  MAX_CAPTURE_REQUESTS,
  MAX_UPLOAD_BYTES,
  type CaptureResponse,
  type CommitResponse,
  type ErrorCode,
  type PresignResponse,
  type UploadKind,
} from '../contracts/api';
import { isShortId } from '../contracts/r2key';
import { collectCaptures } from './capture-pages';
import { movieEndpoint } from './history-view';
import {
  API_REQUEST_TIMEOUT_MS,
  ConversionError,
  convertFilesToMp4,
  convertImageUrlsToMp4,
  StageTimeoutError,
  UPLOAD_PUT_TIMEOUT_MS,
  withStageTimeout,
} from '../convert';
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
 * 撮影は 1 回目の応答が返るまで進捗が来ないため、その間だけ疑似進捗で撮影段階の
 * 帯域の先端を埋める。天井は実進捗の初回値より必ず下に置く（分割取得は最大
 * MAX_CAPTURE_REQUESTS 回なので、1 回目の報告でも撮影全体の 1/MAX_CAPTURE_REQUESTS は進む）。
 * こうしておけば実進捗へ引き継ぐときにバーが戻らない。
 */
const CAPTURE_PSEUDO_INTERVAL_MS = 800;
const CAPTURE_PSEUDO_RATIO_STEP = 0.01;
const CAPTURE_PSEUDO_RATIO_MAX = 1 / MAX_CAPTURE_REQUESTS / 2;

/** アップロード段階の進み具合。presign 完了と R2 への PUT 完了で段階内を進める。 */
const UPLOAD_PRESIGNED_RATIO = 0.2;
const UPLOAD_STORED_RATIO = 0.8;

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
  const images = value.images as string[];
  // totalImages を返さないのは分割取得より前の web-capture。その版は長いページを
  // PAGE_TOO_LONG で失敗させるので、返ってきた分がページ全体とみなして構わない。
  if (value.totalImages === undefined) return { images, totalImages: images.length };
  if (!Number.isSafeInteger(value.totalImages) || (value.totalImages as number) < 0) {
    throw new Error('Invalid capture response');
  }
  return { images, totalImages: value.totalImages as number };
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

/**
 * R2 へ本体を送る。期限を切らないと、詰まったときに「アップロード中 95%」のまま返らない。
 *
 * timeoutMs を引数に出しているのは短い期限でテストできるようにするため（既定値が正本）。
 */
export async function putMp4(
  uploadUrl: string,
  mp4: Blob,
  userSignal?: AbortSignal,
  timeoutMs: number = UPLOAD_PUT_TIMEOUT_MS
): Promise<void> {
  const response = await withStageTimeout('uploadTimeout', timeoutMs, userSignal, (signal) =>
    fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body: mp4,
      signal,
    })
  );
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
}

/**
 * presign / commit を送る。利用者の中止シグナルは渡さない。
 *
 * 予約と確定は「送ったのに結果を知らない」状態を作ってはいけない。中止で打ち切ると
 * pending の行が誰にも回収されないまま残るため、短い要求として応答を必ず待ち、
 * 抜ける手段は期限だけにする。
 */
function requestUploadApi(path: string, body: unknown): Promise<unknown> {
  return withStageTimeout('apiTimeout', API_REQUEST_TIMEOUT_MS, undefined, (signal) =>
    requestJson(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  );
}

export async function uploadMp4(
  mp4: Blob,
  filename: string,
  kind: UploadKind,
  dispatch: Dispatch,
  runGeneration: number,
  signal?: AbortSignal
): Promise<void> {
  if (mp4.size > MAX_UPLOAD_BYTES) {
    dispatch({ type: 'failed', errorCode: 'tooLarge' }, runGeneration);
    return;
  }
  dispatch({ type: 'converted' }, runGeneration);
  const presign = asPresignResponse(
    await requestUploadApi('/api/uploads/presign/', { filename, sizeBytes: mp4.size, kind })
  );
  // 応答を待っている間に中止された場合。予約だけ残るので、抜ける前に取り消す。
  if (signal?.aborted) {
    abandonUpload(presign.shortId);
    signal.throwIfAborted();
  }
  dispatch({ type: 'stageRatio', stage: 'uploading', ratio: UPLOAD_PRESIGNED_RATIO }, runGeneration);

  // presign を通った時点で pending の行が予約されている。ここから先で失敗すると
  // 誰も failed へ落とさないまま残り、cron が回収するまで容量を占め続ける。
  // ただし取り消してよいのは「まだ ready になっていないと確信できる」失敗だけ。
  try {
    await putMp4(presign.uploadUrl, mp4, signal);
  } catch (error) {
    // R2 への PUT 段階の失敗。commit を送っていないので確実に pending のまま。
    abandonUpload(presign.shortId);
    throw error;
  }

  dispatch({ type: 'stageRatio', stage: 'uploading', ratio: UPLOAD_STORED_RATIO }, runGeneration);

  try {
    // commit は中止でも最後まで送り切る。届いた後の中止は「完了」として扱ってよい。
    const committed = asCommitResponse(
      await requestUploadApi('/api/uploads/commit/', { shortId: presign.shortId })
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
  // 段ごとの期限切れは、どこで詰まったかがそのまま表示コードになる。
  if (error instanceof StageTimeoutError) return error.code;
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

  let activeRun: AbortController | null = null;

  /** 新しい変換の世代と中止シグナルを起こす。前の変換が残っていれば道連れに止める。 */
  const startRun = (): { generation: number; signal: AbortSignal } => {
    activeRun?.abort();
    activeRun = new AbortController();
    return { generation: ++generation, signal: activeRun.signal };
  };

  /** 進行中の変換を捨てて初期表示へ戻す。世代を進めるので遅れて届く報告も無視される。 */
  const cancelRun = (): void => {
    if (state.phase !== 'converting' && state.phase !== 'uploading') return;
    activeRun?.abort();
    activeRun = null;
    generation += 1;
    state = INITIAL_UPLOAD_STATE;
    renderConvertPanel(panel, state);
  };

  // BFCache で復元すると完了状態のままになるため、古い非同期処理も無効化して初期表示に戻す。
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    activeRun?.abort();
    activeRun = null;
    generation += 1;
    state = INITIAL_UPLOAD_STATE;
    renderConvertPanel(panel, state);
  });

  element(panel, '[data-abort-button]')?.addEventListener('click', () => {
    cancelRun();
  });

  const fileInput = element<HTMLInputElement>(panel, '[data-file-input]');
  const startFiles = async (files: readonly File[]): Promise<void> => {
    if (files.length === 0) return;
    if (state.phase === 'converting' || state.phase === 'uploading') return;
    // 署名読み取り中に別の入力へ切り替わった場合、古い検証結果で状態を上書きしない。
    const { generation: current, signal } = startRun();
    let preflight;
    try {
      preflight = await preflightInputFiles(files);
    } catch (error) {
      // 選択後にファイルが読めなくなった等。握り潰すと unhandled rejection のまま
      // 画面が idle で固まるので、失敗として見せる。
      console.error('preflight failed', error);
      dispatch({ type: 'failed', errorCode: 'failed' }, current);
      return;
    }
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
    void convertFilesToMp4(
      files,
      kind,
      (progress) => {
        dispatch({ type: 'stageProgress', ...progress }, current);
      },
      signal
    )
      .then((mp4) =>
        uploadMp4(
          mp4,
          movieNameForFiles(
            files.map((file) => file.name),
            panel.dataset['batchNameSuffix'] ?? DEFAULT_BATCH_NAME_SUFFIX
          ),
          kind,
          dispatch,
          current,
          signal
        )
      )
      .catch((error: unknown) => {
        // 中止は失敗ではない。cancelRun が既に初期表示へ戻している。
        if (signal.aborted) return;
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
    const { generation: current, signal } = startRun();
    dispatch({ type: 'selectUrl', url }, current);

    let pseudoRatio = 0;
    const pseudoTimer = window.setInterval(() => {
      pseudoRatio = Math.min(CAPTURE_PSEUDO_RATIO_MAX, pseudoRatio + CAPTURE_PSEUDO_RATIO_STEP);
      dispatch({ type: 'stageRatio', stage: 'capturing', ratio: pseudoRatio }, current);
      if (pseudoRatio >= CAPTURE_PSEUDO_RATIO_MAX) window.clearInterval(pseudoTimer);
    }, CAPTURE_PSEUDO_INTERVAL_MS);

    // 長いページは 1 リクエストの上限を超えるため、必要な回数だけ分けて取得する。
    // 短いページは 1 回で終わるので従来と同じ速度で進む。
    void collectCaptures({
      fetchPage: (startIndex) =>
        requestJson('/api/capture/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, startIndex }),
          signal,
        }).then(asCaptureResponse),
      onProgress: (collected, total) => {
        // 実進捗が来たら疑似進捗は用済み。天井へ届く前の tick が後から入ると戻るので止める。
        window.clearInterval(pseudoTimer);
        dispatch({ type: 'stageProgress', stage: 'capturing', current: collected, total }, current);
      },
    })
      // 成功・失敗のどちらでも疑似進捗を必ず止める（ここから先は実進捗が来る）。
      .finally(() => {
        window.clearInterval(pseudoTimer);
      })
      .then((images) => convertImageUrlsToMp4(images, (progress) => {
        dispatch({ type: 'stageProgress', ...progress }, current);
      }, signal))
      .then((mp4) => uploadMp4(mp4, movieNameForUrl(url), 'web', dispatch, current, signal))
      .catch((error: unknown) => {
        // 中止は失敗ではない。cancelRun が既に初期表示へ戻している。
        if (signal.aborted) return;
        console.error('conversion failed', error);
        dispatch({ type: 'failed', errorCode: uploadErrorCode(error), target: 'url' }, current);
      });
  });

  renderConvertPanel(panel, state);
}
