/**
 * 変換 UI の状態遷移（純粋関数）。
 *
 * DOM も timer も持たないので、ブラウザ無しで決定的にテストできる。
 * 実際のアップロード処理（presign → PUT → commit）は後続タスクが接続するため、
 * ここでは「どの画面状態に居るか」だけを持ち、通信は一切行わない。
 *
 * エラーは文言ではなくコードで返す（i18n 辞書がテキストの正本のため）。
 */

import { MAX_UPLOAD_BYTES, type UploadKind } from '../contracts/api';
import type { ConversionStage } from '../convert/types';
import { ACCEPT_ATTRIBUTE, detectInputKind } from './input-formats';

export { ACCEPT_ATTRIBUTE, preflightInputFiles } from './input-formats';

export const UPLOAD_PHASES = ['idle', 'converting', 'uploading', 'done', 'error'] as const;
export type UploadPhase = (typeof UPLOAD_PHASES)[number];

/**
 * 進捗の段階。convert 側の 2 段階に、その前後の撮影とアップロードを足したもの。
 *
 * 表示する % と枚数は必ず同じ段階のものにする。1 本のバーへ全段階を押し込むと
 * 「100% なのに 88/100」のように別工程の数値が並んでしまうため。
 */
export type ProgressStage = ConversionStage | 'capturing' | 'uploading';

/** 段階が進む順序。過去の段階の報告が遅れて届いてもバーを戻さないための判定に使う。 */
const STAGE_ORDER: Readonly<Record<ProgressStage, number>> = {
  capturing: 0,
  preparing: 1,
  encoding: 2,
  uploading: 3,
};

/** 進捗バーで段階が占める区間（%）。 */
type ProgressBand = readonly [start: number, end: number];

/**
 * URL 変換の帯域。撮影が全体の過半を占めるので、長いページでも撮影中にバーが進む。
 *
 * 帯域は段階順に昇順で連続させる。これによりバーの単調増加は「段階が戻らないこと」
 * だけで保証でき、進捗値へ下限を後付けする（Math.max）必要がない。
 */
const URL_STAGE_BANDS: Readonly<Record<ProgressStage, ProgressBand>> = {
  capturing: [0, 55],
  preparing: [55, 70],
  encoding: [70, 95],
  uploading: [95, 100],
};

/** ファイル変換の帯域。撮影段階が無いので、準備が先頭の帯域を受け持つ。 */
const FILE_STAGE_BANDS: Readonly<Record<ProgressStage, ProgressBand>> = {
  // ファイル変換で撮影は起きないが、帯域表を段階で網羅させるため 0 幅で置く。
  capturing: [0, 0],
  preparing: [0, 70],
  encoding: [70, 95],
  uploading: [95, 100],
};

/** 変換種別に対応する帯域表。URL 変換だけが撮影段階を持つ。 */
export function stageBands(kind: UploadKind | null): Readonly<Record<ProgressStage, ProgressBand>> {
  return kind === 'web' ? URL_STAGE_BANDS : FILE_STAGE_BANDS;
}

export const UPLOAD_ERROR_CODES = [
  'tooLarge',
  'unsupported',
  'tooManyPages',
  'pageTooLong',
  'captureTimeout',
  'sessionExpired',
  'failed',
  'pdfUrlNotSupported',
  'imageUrlNotSupported',
  'videoUrlNotSupported',
  'nonWebPageUrl',
] as const;
export type UploadErrorCode = (typeof UPLOAD_ERROR_CODES)[number];
export type UploadErrorTarget = 'file' | 'url';

export interface UploadState {
  phase: UploadPhase;
  /** 表示中の段階。進捗バーの帯域と段階名の両方をこれで決める。 */
  stage: ProgressStage | null;
  /** 選択中のファイル名。URL 変換のときは対象 URL を入れる。 */
  source: string | null;
  kind: UploadKind | null;
  /** 0〜100。converting / uploading の進捗バー表示に使う。 */
  progress: number;
  /** 現在の段階の処理済み枚数。段階が変わるとリセットする。 */
  current: number | null;
  /** 現在の段階の総枚数。枚数が意味を持たない段階では null。 */
  total: number | null;
  publicUrl: string | null;
  shortId: string | null;
  errorCode: UploadErrorCode | null;
  errorTarget: UploadErrorTarget | null;
}

export const INITIAL_UPLOAD_STATE: UploadState = {
  phase: 'idle',
  stage: null,
  source: null,
  kind: null,
  progress: 0,
  current: null,
  total: null,
  publicUrl: null,
  shortId: null,
  errorCode: null,
  errorTarget: null,
};

export type UploadEvent =
  | { type: 'selectFile'; filename: string; sizeBytes: number }
  | { type: 'selectFiles'; files: readonly { filename: string; sizeBytes: number }[] }
  | { type: 'selectUrl'; url: string }
  | { type: 'stageProgress'; stage: ProgressStage; current: number; total: number }
  | { type: 'stageRatio'; stage: ProgressStage; ratio: number }
  | { type: 'converted' }
  | { type: 'uploaded'; publicUrl: string; shortId: string }
  | { type: 'failed'; errorCode: UploadErrorCode; target?: UploadErrorTarget }
  | { type: 'reset' };

export function detectUploadKind(filename: string): UploadKind | null {
  return detectInputKind(filename);
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 段階の進み具合を全体の進捗へ変換する。
 *
 * 前の段階の報告（遅れて届いた撮影の完了通知など）は捨てる。加えて同じ段階の中でも
 * バーは戻さない: 撮影は途中でページが伸びて総枚数が増えることがあり
 * （`capture-pages.ts` が増加を許容している）、100/150 → 200/500 のように比率だけ見ると
 * 後退する。到達済みの値を下限にしつつ、枚数の表示は最新の値へ更新する。
 */
function advanceStage(
  state: UploadState,
  stage: ProgressStage,
  ratio: number,
  count: { current: number; total: number } | null
): UploadState {
  if (state.phase !== 'converting' && state.phase !== 'uploading') return state;
  if (state.stage !== null && STAGE_ORDER[stage] < STAGE_ORDER[state.stage]) return state;

  const [start, end] = stageBands(state.kind)[stage];
  const reported = clampProgress(start + (end - start) * clampRatio(ratio));
  // 段階が上がった時は帯域の下限まで必ず進める（前段階の到達値に引きずられない）。
  const floor = state.stage === stage ? state.progress : Math.max(state.progress, start);

  return {
    ...state,
    stage,
    current: count?.current ?? null,
    total: count?.total ?? null,
    progress: Math.max(floor, reported),
  };
}

function failure(
  state: UploadState,
  errorCode: UploadErrorCode,
  errorTarget: UploadErrorTarget = 'file'
): UploadState {
  return {
    ...state,
    phase: 'error',
    stage: null,
    progress: 0,
    current: null,
    total: null,
    publicUrl: null,
    shortId: null,
    errorCode,
    errorTarget,
  };
}

function selectFiles(files: readonly { filename: string; sizeBytes: number }[]): UploadState {
  const first = files[0];
  const base: UploadState = {
    ...INITIAL_UPLOAD_STATE,
    source: first?.filename ?? null,
    kind: first ? detectUploadKind(first.filename) : null,
  };
  if (base.kind === null) return failure(base, 'unsupported');
  if (files.some((file) => file.sizeBytes > MAX_UPLOAD_BYTES)) return failure(base, 'tooLarge');
  if (files.some((file) => detectUploadKind(file.filename) !== base.kind)) return failure(base, 'unsupported');
  if (files.length > 1 && base.kind !== 'image') return failure(base, 'unsupported');
  // 準備の最初の報告（PDF の 1 ページ目など）まで数秒あるので、段階名は選択時に出す。
  return { ...base, phase: 'converting', stage: 'preparing' };
}

/**
 * 状態遷移。受け付けない組み合わせ（変換中の再選択など）は現在の状態をそのまま返す。
 *
 * 「変換中に二重投入されない」ことをここで保証しておくと、後続タスクが
 * 通信処理を足すときに UI 側のガードを書き直さずに済む。
 */
export function reduceUpload(state: UploadState, event: UploadEvent): UploadState {
  switch (event.type) {
    case 'selectFile': {
      if (state.phase === 'converting' || state.phase === 'uploading') return state;
      return selectFiles([event]);
    }

    case 'selectFiles': {
      if (state.phase === 'converting' || state.phase === 'uploading') return state;
      return selectFiles(event.files);
    }

    case 'selectUrl': {
      if (state.phase === 'converting' || state.phase === 'uploading') return state;

      return { ...INITIAL_UPLOAD_STATE, phase: 'converting', stage: 'capturing', source: event.url, kind: 'web' };
    }

    case 'stageProgress': {
      if (event.total <= 0 || event.current < 0) return state;
      const current = Math.min(event.current, event.total);
      return advanceStage(state, event.stage, current / event.total, { current, total: event.total });
    }

    case 'stageRatio':
      return advanceStage(state, event.stage, event.ratio, null);

    case 'converted': {
      if (state.phase !== 'converting') return state;
      // アップロード帯域の先頭へ移る。0 に戻すとバーが後退するため戻さない。
      const [start] = stageBands(state.kind).uploading;
      return { ...state, phase: 'uploading', stage: 'uploading', progress: start, current: null, total: null };
    }

    case 'uploaded': {
      if (state.phase !== 'uploading') return state;
      return { ...state, phase: 'done', progress: 100, current: null, total: null, publicUrl: event.publicUrl, shortId: event.shortId };
    }

    case 'failed':
      return failure(state, event.errorCode, event.target);

    case 'reset':
      return INITIAL_UPLOAD_STATE;
  }
}
