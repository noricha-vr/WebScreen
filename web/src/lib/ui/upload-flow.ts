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

export const UPLOAD_PHASES = ['idle', 'converting', 'uploading', 'done', 'error'] as const;
export type UploadPhase = (typeof UPLOAD_PHASES)[number];

export const UPLOAD_ERROR_CODES = ['tooLarge', 'unsupported', 'failed'] as const;
export type UploadErrorCode = (typeof UPLOAD_ERROR_CODES)[number];

/** 拡張子 → アップロード種別。UPLOAD_KINDS（契約）に無い種別は増やさない。 */
const EXTENSION_KINDS: Readonly<Record<string, UploadKind>> = {
  pdf: 'pdf',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
};

/** <input type="file"> の accept 属性値。表示上の対応形式リストと同じ集合にする。 */
export const ACCEPT_ATTRIBUTE = Object.keys(EXTENSION_KINDS)
  .map((extension) => `.${extension}`)
  .join(',');

export interface UploadState {
  phase: UploadPhase;
  /** 選択中のファイル名。URL 変換のときは対象 URL を入れる。 */
  source: string | null;
  kind: UploadKind | null;
  /** 0〜100。converting / uploading の進捗バー表示に使う。 */
  progress: number;
  publicUrl: string | null;
  errorCode: UploadErrorCode | null;
}

export const INITIAL_UPLOAD_STATE: UploadState = {
  phase: 'idle',
  source: null,
  kind: null,
  progress: 0,
  publicUrl: null,
  errorCode: null,
};

export type UploadEvent =
  | { type: 'selectFile'; filename: string; sizeBytes: number }
  | { type: 'selectUrl'; url: string }
  | { type: 'progress'; value: number }
  | { type: 'converted' }
  | { type: 'uploaded'; publicUrl: string }
  | { type: 'failed'; errorCode: UploadErrorCode }
  | { type: 'reset' };

export function detectUploadKind(filename: string): UploadKind | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;

  const extension = filename.slice(dot + 1).toLowerCase();
  return EXTENSION_KINDS[extension] ?? null;
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function failure(state: UploadState, errorCode: UploadErrorCode): UploadState {
  return { ...state, phase: 'error', progress: 0, publicUrl: null, errorCode };
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

      const base: UploadState = {
        ...INITIAL_UPLOAD_STATE,
        source: event.filename,
        kind: detectUploadKind(event.filename),
      };
      if (base.kind === null) return failure(base, 'unsupported');
      if (event.sizeBytes > MAX_UPLOAD_BYTES) return failure(base, 'tooLarge');

      return { ...base, phase: 'converting' };
    }

    case 'selectUrl': {
      if (state.phase === 'converting' || state.phase === 'uploading') return state;

      return { ...INITIAL_UPLOAD_STATE, phase: 'converting', source: event.url, kind: 'web' };
    }

    case 'progress': {
      if (state.phase !== 'converting' && state.phase !== 'uploading') return state;
      return { ...state, progress: clampProgress(event.value) };
    }

    case 'converted': {
      if (state.phase !== 'converting') return state;
      return { ...state, phase: 'uploading', progress: 0 };
    }

    case 'uploaded': {
      if (state.phase !== 'uploading') return state;
      return { ...state, phase: 'done', progress: 100, publicUrl: event.publicUrl };
    }

    case 'failed':
      return failure(state, event.errorCode);

    case 'reset':
      return INITIAL_UPLOAD_STATE;
  }
}
