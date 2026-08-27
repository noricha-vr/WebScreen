/**
 * Worker API と web-capture API のリクエスト / レスポンス契約。
 *
 * この 1 ファイルが producer（Worker のハンドラ）と consumer（ブラウザ JS・
 * web-capture サービス）の共通の正本。docs/api-contracts.md は本ファイルを
 * 参照するだけで、型の内容を再掲しない。
 *
 * 外部公開フィールドは camelCase（~/.claude/rules/api-design.md）。
 * D1 のカラム名（short_id など）は snake_case なので、境界で変換する。
 */

import { isShortId } from './r2key';

/** 1 ファイルあたりのアップロード上限（50 MiB）。R2 の単発 PUT で扱える範囲に収める。 */
export const MAX_UPLOAD_BYTES = 52_428_800;

/** アップロード元の種別。ローカル入力は PDF / 画像、URL 変換は web に限定する。 */
export const UPLOAD_KINDS = ['pdf', 'image', 'web'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

/** 動画のライフサイクル。D1 movies.status の CHECK 制約と一致させること。 */
export const MOVIE_STATUSES = ['pending', 'ready', 'failed'] as const;
export type MovieStatus = (typeof MOVIE_STATUSES)[number];

/** ファイル名の上限。R2 のメタデータと D1 の行を無闇に太らせないための実務値。 */
export const MAX_FILENAME_LENGTH = 255;

/** web-capture のキャプチャ解像度の許容範囲。VRChat のビデオプレイヤー想定。 */
export const MIN_CAPTURE_DIMENSION = 320;
export const MAX_CAPTURE_DIMENSION = 3840;
export const DEFAULT_CAPTURE_WIDTH = 1920;
export const DEFAULT_CAPTURE_HEIGHT = 1080;

// ---------------------------------------------------------------------------
// エラー
// ---------------------------------------------------------------------------

/**
 * エラーコード。HTTP ステータスと別に機械可読な識別子を返し、
 * クライアントが文言ではなくコードで分岐できるようにする。
 */
export const ERROR_CODES = {
  invalidRequest: 'INVALID_REQUEST',
  unauthorized: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  notFound: 'NOT_FOUND',
  payloadTooLarge: 'PAYLOAD_TOO_LARGE',
  captureFailed: 'CAPTURE_FAILED',
  pdfUrlNotSupported: 'PDF_URL_NOT_SUPPORTED',
  imageUrlNotSupported: 'IMAGE_URL_NOT_SUPPORTED',
  videoUrlNotSupported: 'VIDEO_URL_NOT_SUPPORTED',
  nonWebPageUrl: 'NON_WEB_PAGE_URL',
  internalError: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorResponse {
  errorCode: ErrorCode;
  message: string;
}

// ---------------------------------------------------------------------------
// POST /api/uploads/presign/ — R2 への直接アップロード先を払い出す
// ---------------------------------------------------------------------------

export interface PresignRequest {
  filename: string;
  sizeBytes: number;
  kind: UploadKind;
}

export interface PresignResponse {
  shortId: string;
  /** クライアントが PUT する先。有効期限つきの署名 URL。 */
  uploadUrl: string;
  /** commit 後に誰でも参照できる公開 URL。 */
  publicUrl: string;
}

// ---------------------------------------------------------------------------
// POST /api/uploads/commit/ — アップロード完了を確定し status を ready にする
// ---------------------------------------------------------------------------

export interface CommitRequest {
  shortId: string;
}

export interface CommitResponse {
  shortId: string;
  publicUrl: string;
  sizeBytes: number;
  /** ISO8601。pin されている場合は null（自動削除の対象外）。 */
  expiresAt: string | null;
}

// ---------------------------------------------------------------------------
// POST /capture — web-capture サービス（別 Worker / コンテナ）
// ---------------------------------------------------------------------------

export interface CaptureRequest {
  url: string;
  width?: number;
  height?: number;
}

export interface CaptureResponse {
  /**
   * 撮影したスクリーンショットの公開 URL。
   *
   * 契約: 配列は「撮影（スクロール）順」で返す。先頭がページ最上部、末尾が最下部。
   * 順序が狂うとスクロール動画が破綻するため、並べ替え・非決定な並列 map の
   * 結果をそのまま詰めることを禁止する（R2 キーの 0 埋め連番と一致させる。
   * キー導出は contracts/r2key.ts の captureKey が正本）。
   */
  images: string[];
}

// ---------------------------------------------------------------------------
// バリデータ
// ---------------------------------------------------------------------------

/**
 * バリデーション結果。例外ではなく値で失敗を返し、ハンドラ側が
 * そのまま ErrorResponse として返せるようにする。
 */
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ErrorResponse };

function invalid(message: string): { ok: false; error: ErrorResponse } {
  return { ok: false, error: { errorCode: ERROR_CODES.invalidRequest, message } };
}

function tooLarge(message: string): { ok: false; error: ErrorResponse } {
  return { ok: false, error: { errorCode: ERROR_CODES.payloadTooLarge, message } };
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

/** パス区切り・偽装に使える制御文字を含まない実ファイル名かを判定する。 */
export function isSafeFilename(value: string): boolean {
  if (value.length === 0 || value.length > MAX_FILENAME_LENGTH) return false;
  if (value.includes('/') || value.includes('\\')) return false;
  if (value === '.' || value === '..') return false;
  // Cc と bidi / 行区切りはログ注入・拡張子偽装に使える。絵文字の ZWJ / ZWNJ / VS は許可する。
  return !/[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value);
}

export function validatePresignRequest(input: unknown): ValidationResult<PresignRequest> {
  const body = asRecord(input);
  if (!body) return invalid('リクエストボディは JSON オブジェクトである必要があります');

  const { filename, sizeBytes, kind } = body;

  if (typeof filename !== 'string' || !isSafeFilename(filename)) {
    return invalid('filename が不正です');
  }
  if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    return invalid('sizeBytes は 1 以上の整数である必要があります');
  }
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    return tooLarge(`sizeBytes が上限 ${MAX_UPLOAD_BYTES} バイトを超えています`);
  }
  if (typeof kind !== 'string' || !(UPLOAD_KINDS as readonly string[]).includes(kind)) {
    return invalid(`kind は ${UPLOAD_KINDS.join(' | ')} のいずれかである必要があります`);
  }

  return { ok: true, value: { filename, sizeBytes, kind: kind as UploadKind } };
}

export function validateCommitRequest(input: unknown): ValidationResult<CommitRequest> {
  const body = asRecord(input);
  if (!body) return invalid('リクエストボディは JSON オブジェクトである必要があります');

  const { shortId } = body;
  if (typeof shortId !== 'string' || !isShortId(shortId)) {
    return invalid('shortId が不正です');
  }

  return { ok: true, value: { shortId } };
}

export function validateCaptureRequest(input: unknown): ValidationResult<CaptureRequest> {
  const body = asRecord(input);
  if (!body) return invalid('リクエストボディは JSON オブジェクトである必要があります');

  const { url, width, height } = body;

  if (typeof url !== 'string' || !isHttpUrl(url)) {
    return invalid('url は http/https の絶対 URL である必要があります');
  }

  const validatedWidth = validateDimension(width, 'width');
  if (!validatedWidth.ok) return validatedWidth;
  const validatedHeight = validateDimension(height, 'height');
  if (!validatedHeight.ok) return validatedHeight;

  const value: CaptureRequest = { url };
  if (validatedWidth.value !== undefined) value.width = validatedWidth.value;
  if (validatedHeight.value !== undefined) value.height = validatedHeight.value;
  return { ok: true, value };
}

function validateDimension(
  input: unknown,
  field: 'width' | 'height'
): ValidationResult<number | undefined> {
  if (input === undefined) return { ok: true, value: undefined };
  if (typeof input !== 'number' || !Number.isInteger(input)) {
    return invalid(`${field} は整数である必要があります`);
  }
  if (input < MIN_CAPTURE_DIMENSION || input > MAX_CAPTURE_DIMENSION) {
    return invalid(
      `${field} は ${MIN_CAPTURE_DIMENSION}〜${MAX_CAPTURE_DIMENSION} の範囲である必要があります`
    );
  }
  return { ok: true, value: input };
}

/** SSRF を避けるため、スキームを http/https に限定する（ホストの許可判定は呼び出し側の責務）。 */
function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}
