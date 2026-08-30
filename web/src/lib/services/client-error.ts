/**
 * クライアント側の失敗報告を受けて構造化ログに残す。
 *
 * この口は**無認証**（未ログインの失敗こそ見たいため）。したがって受け取った値は
 * すべて敵性入力として扱い、契約（contracts/client-error.ts）を通った識別子だけを
 * ログへ渡す。応答は 204 固定で、報告者に情報を返さない。
 */

import { ERROR_CODES } from '../contracts/api';
import {
  MAX_CLIENT_ERROR_BODY_BYTES,
  validateClientErrorReport,
} from '../contracts/client-error';
import { SESSION_COOKIE_NAME, readCookie, verifySession } from '../contracts/session';
import { logClientError } from '../infra/worker-log';

export interface ClientErrorDeps {
  /** あればセッションを検証して userId をログに添える。無ければ guest として記録する。 */
  signingKey?: CryptoKey;
  nowSeconds?: number;
}

/** 不正な報告はすべて同じ 400 で落とす（種類を返し分けても報告者には使い道がない）。 */
function rejected(message: string): Response {
  return Response.json(
    { errorCode: ERROR_CODES.invalidRequest, message },
    { status: 400, headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function handleClientErrorReport(
  request: Request,
  deps: ClientErrorDeps = {}
): Promise<Response> {
  const text = await readLimitedText(request, MAX_CLIENT_ERROR_BODY_BYTES);
  if (text === null) return rejected('リクエストボディが大きすぎます');

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return rejected('リクエストボディは JSON である必要があります');
  }

  const result = validateClientErrorReport(payload);
  if (!result.ok) {
    return Response.json(result.error, { status: 400, headers: { 'Cache-Control': 'no-store' } });
  }

  const userId = await resolveUserId(request, deps);
  logClientError({ ...result.value, userId });

  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Cookie の署名だけで userId を決める（D1 は引かない）。
 *
 * 誰でも叩ける口なので、報告 1 件ごとに DB を触らせない。存在しないユーザーの
 * 署名済み Cookie が来ても、ログに数字が 1 つ残るだけで実害はない。
 */
async function resolveUserId(
  request: Request,
  deps: ClientErrorDeps
): Promise<number | undefined> {
  if (!deps.signingKey) return undefined;
  const token = readCookie(request.headers.get('Cookie'), SESSION_COOKIE_NAME);
  if (!token) return undefined;
  const session = await verifySession(token, deps.signingKey, deps.nowSeconds);
  return session?.uid;
}

/**
 * 上限を超えた時点で読み取りを打ち切る。
 *
 * Content-Length は自己申告なので、宣言値の検査だけでは足りない（申告せずに
 * 大きな本文を流し込めるため）。実際に読んだバイト数でも必ず切る。
 */
async function readLimitedText(request: Request, maxBytes: number): Promise<string | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const size = Number(declared);
    if (!Number.isFinite(size) || size > maxBytes) return null;
  }

  const body = request.body;
  if (!body) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
