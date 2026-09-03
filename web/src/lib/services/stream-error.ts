import type { ErrorCode, ErrorResponse } from '../contracts/api';

/** stream API が HTTP 応答へ変換する、公開済みの失敗理由を表す。 */
export class StreamError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 429,
    public readonly errorCode: ErrorCode,
    message: string,
    public readonly details: Pick<ErrorResponse, 'retryAfterSeconds'> = {}
  ) {
    super(message);
  }
}
