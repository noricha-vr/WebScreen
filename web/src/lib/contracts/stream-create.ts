import { ERROR_CODES, type ErrorResponse, type ValidationResult } from './api';
import { isShortId } from './r2key';

/** `POST /api/streams/` の開始・再利用リクエスト。 */
export interface CreateStreamRequest {
  id?: string;
}

/** 新規発行または既存配信 URL の再利用リクエストを検証する。 */
export function validateCreateStreamRequest(input: unknown): ValidationResult<CreateStreamRequest> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalid();
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some((key) => key !== 'id')) return invalid();
  if (body.id !== undefined && (typeof body.id !== 'string' || !isShortId(body.id))) return invalid();
  return { ok: true, value: body.id === undefined ? {} : { id: body.id } };
}

function invalid(): { ok: false; error: ErrorResponse } {
  return { error: { errorCode: ERROR_CODES.invalidRequest, message: '配信開始リクエストが不正です' }, ok: false };
}
