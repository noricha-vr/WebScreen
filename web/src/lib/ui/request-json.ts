interface ErrorBody {
  errorCode?: unknown;
}

/** HTTP エラー時に安全に読めた errorCode だけを保持する。 */
export class JsonRequestError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string | null
  ) {
    super('JSON request failed');
  }
}

/** JSON API を呼び、失敗時はレスポンス本文を露出せずに失敗コードだけを返す。 */
export async function requestJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const response = await fetchImpl(url, { ...init, credentials: 'same-origin' });
  const body = await responseJson(response);
  if (!response.ok) throw new JsonRequestError(response.status, errorCode(body.value));
  // 成功応答なのに JSON として読めないのは上流の異常。null を返すと呼び出し側が
  // 「空の結果」と誤認する（履歴が「0 件」と表示される等）ため、失敗として投げる。
  if (!body.parsed) throw new JsonRequestError(response.status, null);
  return body.value;
}

/** 認証切れを HTTP ステータスまたは安全に読めたエラーコードから判定する。 */
export function isUnauthorizedRequestError(error: unknown): boolean {
  return (
    error instanceof JsonRequestError &&
    (error.status === 401 || error.errorCode === 'UNAUTHORIZED')
  );
}

/** 本文を読み、JSON として解釈できたかを値と一緒に返す。空本文（204 等）は成功扱い。 */
async function responseJson(response: Response): Promise<{ parsed: boolean; value: unknown }> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { parsed: false, value: null };
  }

  if (text.trim() === '') return { parsed: true, value: null };

  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false, value: null };
  }
}

function errorCode(value: unknown): string | null {
  if (!isErrorBody(value) || typeof value.errorCode !== 'string') return null;
  return value.errorCode;
}

function isErrorBody(value: unknown): value is ErrorBody {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
