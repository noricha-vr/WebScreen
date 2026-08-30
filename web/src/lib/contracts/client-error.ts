/**
 * クライアント側の失敗報告（`POST /api/client-error/`）の契約。
 *
 * producer はブラウザ（lib/ui）、consumer は Worker（services/client-error.ts）。
 * 運用の目的は「どの段で落ちたか」を数えることだけなので、載せてよいのは
 * **識別子と HTTP ステータスだけ**にする。URL・ファイル名・ページ内容・
 * スタックトレース・自由記述は受け取らない（受け取れば Worker のログに残り、
 * 後から消せない情報になる）。
 *
 * 自由記述を締め出す手段は allowlist と未知キーの拒否の 2 つ。片方だけだと
 * 「見慣れないフィールドに本文を詰めて送る」経路が残る。
 *
 * api.ts と分けているのは、api.ts が契約ファイルの行数上限（400 行）に近く、
 * この 1 機能を足すと超えるため（層は同じ contracts で、正本の位置は変わらない）。
 */

import { ERROR_CODES, type ErrorCode, type ValidationResult } from './api';

/** 失敗した段。UI の工程と 1 対 1 に対応させ、ログの絞り込みキーにする。 */
export const CLIENT_ERROR_STAGES = [
  'capture',
  'convert',
  'upload',
  'pin',
  'rename',
  'delete',
  'history',
  'session',
] as const;
export type ClientErrorStage = (typeof CLIENT_ERROR_STAGES)[number];

/**
 * ブラウザ内で完結する失敗の表示コード。ui/upload-flow.ts の UploadErrorCode と
 * 同じ値を受け付ける（あちらが UI 表示の正本、こちらが受信の正本。取りこぼしは
 * tests/contracts/client-error.test.ts の包含テストが機械的に検出する）。
 */
const CLIENT_UI_ERROR_CODES = [
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
  'wasmLoadTimeout',
  'imageFetchTimeout',
  'uploadTimeout',
  'apiTimeout',
] as const;
type ClientUiErrorCode = (typeof CLIENT_UI_ERROR_CODES)[number];

/** 受け付けるコード。API のエラーコードと UI の表示コードの和集合。 */
export type ClientErrorCode = ErrorCode | ClientUiErrorCode;
export const CLIENT_ERROR_CODES: readonly ClientErrorCode[] = [
  ...Object.values(ERROR_CODES),
  ...CLIENT_UI_ERROR_CODES,
];

const ALLOWED_CODES: ReadonlySet<string> = new Set<string>(CLIENT_ERROR_CODES);

/** allowlist に載っているコードか。サーバー応答をそのまま転送しないための門番。 */
export function isClientErrorCode(value: string): value is ClientErrorCode {
  return ALLOWED_CODES.has(value);
}

/**
 * 本文の上限（バイト）。識別子 3 つに 1 KiB は十分すぎるので、これを超える本文は
 * 中身を見るまでもなく契約違反として捨てる（無認証の口なので読み切る前に止める）。
 */
export const MAX_CLIENT_ERROR_BODY_BYTES = 1024;

/** 受け付けるフィールドはこの 3 つだけ。増やすときは「識別子か」を必ず問う。 */
export interface ClientErrorReport {
  stage: ClientErrorStage;
  errorCode: ClientErrorCode;
  /** 失敗が HTTP 応答由来のときだけ。ブラウザ内の失敗では省く。 */
  httpStatus?: number;
}

const REPORT_FIELDS: readonly string[] = ['stage', 'errorCode', 'httpStatus'];

function invalid(message: string): { ok: false; error: { errorCode: ErrorCode; message: string } } {
  return { ok: false, error: { errorCode: ERROR_CODES.invalidRequest, message } };
}

/**
 * 失敗報告を検証する。
 *
 * 既存の validate* と違い**未知のフィールドを拒否する**。無視すると、そこへ
 * 自由記述を詰めた報告が「正当な報告」として通り続けてしまうため。
 */
export function validateClientErrorReport(input: unknown): ValidationResult<ClientErrorReport> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('リクエストボディは JSON オブジェクトである必要があります');
  }
  const body = input as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (!REPORT_FIELDS.includes(key)) return invalid('未知のフィールドは受け付けません');
  }

  const { stage, errorCode, httpStatus } = body;

  if (typeof stage !== 'string' || !(CLIENT_ERROR_STAGES as readonly string[]).includes(stage)) {
    return invalid('stage が不正です');
  }
  if (typeof errorCode !== 'string' || !isClientErrorCode(errorCode)) {
    return invalid('errorCode が不正です');
  }
  if (httpStatus !== undefined) {
    if (typeof httpStatus !== 'number' || !Number.isInteger(httpStatus)) {
      return invalid('httpStatus は整数である必要があります');
    }
    if (httpStatus < 100 || httpStatus > 599) return invalid('httpStatus が範囲外です');
  }

  const value: ClientErrorReport = { stage: stage as ClientErrorStage, errorCode };
  if (httpStatus !== undefined) value.httpStatus = httpStatus;
  return { ok: true, value };
}
