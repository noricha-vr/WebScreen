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
export type {
  CreateStreamResponse,
  ExtendStreamResponse,
  StopLiveStreamsResponse,
  StreamEndReason,
  StreamHealthResponse,
  StreamSessionStatus,
  StreamStatusResponse,
} from './streams';
/** 1 ファイルあたりのアップロード上限（50 MiB）。R2 の単発 PUT で扱える範囲に収める。 */
export const MAX_UPLOAD_BYTES = 52_428_800;
/** abandon の JSON 本文上限。shortId 1 件に対し十分な余裕を持たせる。 */
export const MAX_ABANDON_UPLOAD_BODY_BYTES = 4 * 1024;

/** アップロード元の種別。ローカル入力は PDF / 画像、URL 変換は web に限定する。 */
export const UPLOAD_KINDS = ['pdf', 'image', 'web'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

/** 動画のライフサイクル。D1 movies.status の CHECK 制約と一致させること。 */
export const MOVIE_STATUSES = ['pending', 'ready', 'failed'] as const;
export type MovieStatus = (typeof MOVIE_STATUSES)[number];

/** ファイル名の上限。R2 のメタデータと D1 の行を無闇に太らせないための実務値。 */
export const MAX_FILENAME_LENGTH = 255;

/**
 * 1 ページを変換するときに撮ってよいスクリーンショットの総枚数。
 *
 * 上限の理由はアップロードのバイト数。`FRAME_RATE = 1` と全キーフレーム（`-g 1 -bf 0`）の
 * 組み合わせで動画は全フレームが I フレームになり、サイズは枚数にほぼ正比例する
 * （実測は docs/encode-contract.md「1 ページの上限枚数」）。実測の最悪ケース（文字主体の
 * ページ）が 262 KB/枚で、`MAX_UPLOAD_BYTES` を割ると 199 枚でちょうど上限に張り付く。
 * 実測より 1.3 倍重いページでも収まるよう 150 枚を採用する（150 枚 = 約 37.6 MiB）。
 *
 * この値は web-capture と共有する契約。web-capture 側は app/models.py に同じ値を持ち、
 * 撮影を始める前にページの推定枚数と突き合わせて `capture_limit_exceeded` を返す。
 */
export const MAX_CAPTURE_IMAGES = 150;

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
  expired: 'EXPIRED',
  payloadTooLarge: 'PAYLOAD_TOO_LARGE',
  tooManyPendingUploads: 'TOO_MANY_PENDING_UPLOADS',
  tooManyPresignRequests: 'TOO_MANY_PRESIGN_REQUESTS',
  streamAlreadyLive: 'STREAM_ALREADY_LIVE',
  streamCapacityReached: 'STREAM_CAPACITY_REACHED',
  streamCreateRateLimited: 'STREAM_CREATE_RATE_LIMITED',
  streamStartCancelled: 'STREAM_START_CANCELLED',
  streamEnded: 'STREAM_ENDED',
  captureFailed: 'CAPTURE_FAILED',
  pageTooLong: 'PAGE_TOO_LONG',
  captureTimeout: 'CAPTURE_TIMEOUT',
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
  /**
   * `PAGE_TOO_LONG` のときだけ付く、ページ全体に必要と推定した画面数。
   *
   * 上限そのものは送らない（`MAX_CAPTURE_IMAGES` が両側の正本なので、payload へ
   * 載せると値が二重管理になる）。文言への差し込みは表示側が辞書と組み合わせて行う。
   */
  estimatedImages?: number;
}

/** 推定画面数の受理上限。桁数を抑えて表示崩れとログ汚染を防ぐだけの値。 */
const MAX_ESTIMATED_IMAGES = 100_000;

/**
 * 上流・API 応答から推定画面数だけを安全に取り出す。
 *
 * 表示にしか使わない値なので、整数でない・0 以下・非現実的に大きい値は
 * 落として無いものとして扱う（本文をそのまま画面へ流さないため）。
 */
export function parseEstimatedImages(value: unknown): number | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const estimated = (value as { estimatedImages?: unknown }).estimatedImages;
  if (typeof estimated !== 'number' || !Number.isSafeInteger(estimated)) return null;
  if (estimated <= 0 || estimated > MAX_ESTIMATED_IMAGES) return null;
  return estimated;
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
  /** ISO8601。pin すると 1 年後まで延びる。null は期限を持たない古い行だけ。 */
  expiresAt: string | null;
}

// ---------------------------------------------------------------------------
// POST /api/uploads/abandon/ — 未確定アップロードを failed にする
// ---------------------------------------------------------------------------

/** failed 掃除へ引き渡す未確定アップロードを指定する。 */
export interface AbandonUploadRequest {
  shortId: string;
}

// ---------------------------------------------------------------------------
// POST /capture — web-capture サービス（別 Worker / コンテナ）
// ---------------------------------------------------------------------------

export interface CaptureRequest {
  url: string;
  width?: number;
  height?: number;
  /**
   * 撮影を始める位置（0 始まり）。長いページは 1 リクエストの上限を超えるため、
   * 前回の続きからを指定して複数回に分けて取得する。
   *
   * このフィールドを送ること自体が「分割取得に対応したクライアント」の合図になる。
   * 送らないリクエストは上限超過時に PAGE_TOO_LONG で失敗する（途中までの動画を
   * 黙って作らないため）。
   */
  startIndex?: number;
}

export interface CaptureResponse {
  /**
   * このリクエストで撮影したスクリーンショットの公開 URL。
   *
   * 契約: 配列は「撮影（スクロール）順」で返す。先頭が startIndex の位置、末尾がその続き。
   * 順序が狂うとスクロール動画が破綻するため、並べ替え・非決定な並列 map の
   * 結果をそのまま詰めることを禁止する（R2 キーの 0 埋め連番と一致させる。
   * キー導出は contracts/r2key.ts の captureKey が正本）。
   */
  images: string[];
  /** ページ全体で必要な総枚数（開始位置に関わらない）。何回に分けて取るかの判断に使う。 */
  totalImages: number;
}

/**
 * 1 ページあたりに許容する分割取得の回数。無限ループと過大なページの歯止め。
 *
 * web-capture は 1 リクエストにつき 100 枚までしか撮らないので、この回数 × 100 が
 * クライアントの取得可能枚数になる。`MAX_CAPTURE_IMAGES` 以上でなければ、上限内の
 * ページなのに取り切れずに失敗する。
 */
export const MAX_CAPTURE_REQUESTS = 6;

// ---------------------------------------------------------------------------
// 動画メタデータ — GET /api/history/, POST /api/movies/{shortId}/pin/,
//                 PATCH /api/movies/{shortId}/
// ---------------------------------------------------------------------------

/** 履歴 1 件。外部公開フィールドなので camelCase（D1 の snake_case は services/movies.ts で変換する）。 */
export interface HistoryEntry {
  shortId: string;
  filename: string;
  status: MovieStatus;
  pinned: boolean;
  /** ISO8601。D1 の DEFAULT datetime('now') は UTC の "YYYY-MM-DD HH:MM:SS" なので境界で正規化する。 */
  createdAt: string;
  /** ISO8601。pin 中は 1 年後の期限が入る。null は期限を持たない古い行だけ。 */
  expiresAt: string | null;
  publicUrl: string;
}

/** `GET /api/history/` の応答。配列を直接返さず包むのは、後で件数などを足せるようにするため。 */
export interface HistoryResponse {
  movies: HistoryEntry[];
}

/** `POST /api/movies/{shortId}/pin/` の応答。 */
export interface PinResponse {
  shortId: string;
  pinned: boolean;
  expiresAt: string | null;
}

/** `PATCH /api/movies/{shortId}/` のリクエスト。 */
export interface RenameMovieRequest {
  filename: string;
}

/** ファイル名変更の応答。 */
export interface RenameMovieResponse {
  shortId: string;
  filename: string;
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

/** 未確定アップロードの放棄リクエストを検証する。 */
export function validateAbandonUploadRequest(input: unknown): ValidationResult<AbandonUploadRequest> {
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

  const { url, width, height, startIndex } = body;

  if (typeof url !== 'string' || !isHttpUrl(url)) {
    return invalid('url は http/https の絶対 URL である必要があります');
  }

  const validatedWidth = validateDimension(width, 'width');
  if (!validatedWidth.ok) return validatedWidth;
  const validatedHeight = validateDimension(height, 'height');
  if (!validatedHeight.ok) return validatedHeight;

  // 検証で落とすと上流へ届かず、常に先頭からの撮影になって同じ画像を繰り返し繋いでしまう。
  if (startIndex !== undefined && (!Number.isSafeInteger(startIndex) || (startIndex as number) < 0)) {
    return invalid('startIndex は 0 以上の整数である必要があります');
  }

  const value: CaptureRequest = { url };
  if (validatedWidth.value !== undefined) value.width = validatedWidth.value;
  if (validatedHeight.value !== undefined) value.height = validatedHeight.value;
  if (startIndex !== undefined) value.startIndex = startIndex as number;
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

/**
 * ファイル名変更のリクエストを検証する。
 *
 * 前後の空白は UI 由来で混ざりやすいので落として受理し、trim 後の値を正とする
 * （サービス層は検証済みの値をそのまま保存する）。
 */
export function validateRenameMovieRequest(input: unknown): ValidationResult<RenameMovieRequest> {
  const body = asRecord(input);
  if (!body) return invalid('リクエストボディは JSON オブジェクトである必要があります');

  const { filename } = body;
  if (typeof filename !== 'string') return invalid('filename が不正です');

  // 空文字と MAX_FILENAME_LENGTH 超も isSafeFilename が弾く（空白のみは trim 後に空文字になる）。
  const trimmed = filename.trim();
  if (!isSafeFilename(trimmed)) return invalid('filename が不正です');

  return { ok: true, value: { filename: trimmed } };
}
