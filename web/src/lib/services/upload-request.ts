/** アップロード API の小さな JSON 本文を制限付きで読む。 */

import { ERROR_CODES, type ErrorResponse } from '../contracts/api';

export type LimitedJsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; error: ErrorResponse };

export interface ReadLimitedJsonBodyOptions {
  /** 空白だけの本文を後方互換用の値として扱う。 */
  emptyValue?: unknown;
}

/** Content-Length と実読み込み量の両方で JSON 本文を制限する。 */
export async function readLimitedJsonBody(
  request: Request,
  maxBytes: number,
  options: ReadLimitedJsonBodyOptions = {}
): Promise<LimitedJsonBodyResult> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) return invalidBody();
    if (declaredBytes > maxBytes) return oversizedBody();
  }

  const body = request.body;
  if (!body) return invalidBody();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return oversizedBody();
      }
      chunks.push(value);
    }
  } catch {
    return invalidBody();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder().decode(bytes);
  if (text.trim() === '' && Object.hasOwn(options, 'emptyValue')) {
    return { ok: true, value: options.emptyValue };
  }

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return invalidBody();
  }
}

function invalidBody(): LimitedJsonBodyResult {
  return {
    ok: false,
    status: 400,
    error: {
      errorCode: ERROR_CODES.invalidRequest,
      message: 'リクエストボディは JSON である必要があります',
    },
  };
}

function oversizedBody(): LimitedJsonBodyResult {
  return {
    ok: false,
    status: 413,
    error: {
      errorCode: ERROR_CODES.payloadTooLarge,
      message: 'リクエストボディが大きすぎます',
    },
  };
}
