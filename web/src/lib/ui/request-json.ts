interface ErrorBody {
  errorCode?: unknown;
}

/** HTTP エラー時に安全に読めた errorCode だけを保持する。 */
export class JsonRequestError extends Error {
  constructor(readonly errorCode: string | null) {
    super('JSON request failed');
  }
}

/** JSON API を呼び、失敗時はレスポンス本文を露出せずに失敗コードだけを返す。 */
export async function requestJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, credentials: 'same-origin' });
  const body = await responseJson(response);
  if (!response.ok) throw new JsonRequestError(errorCode(body));
  return body;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorCode(value: unknown): string | null {
  if (!isErrorBody(value) || typeof value.errorCode !== 'string') return null;
  return value.errorCode;
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
