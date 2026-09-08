/**
 * 更新系リクエスト（POST / PATCH / DELETE 等）のクロス origin 拒否（CSRF 対策）。
 *
 * Worker の更新系 API はすべてセッション Cookie（SameSite=Lax）だけで認証している。
 * Lax は同一 site（兄弟サブドメイン）からの POST に Cookie を付けるため、サブドメインが
 * 1 つ侵害されると、そこからのフォーム送信で本人の状態（動画削除など）を変更できてしまう。
 * ブラウザは POST 系に必ず `Origin` を付け、JS からは書き換えられないので、
 * `Origin` がリクエスト URL の origin と一致することを主判定にする。
 *
 * Astro 自身の `security.checkOrigin`（既定 on）はフォーム系 Content-Type と Content-Type
 * 無しの場合しか見ず、`application/json` は素通しする。本モジュールは Content-Type に
 * 依らず更新系メソッド全体へ同じ判定を掛け、拒否は `ErrorResponse`（`FORBIDDEN`）で返す。
 *
 * Worker の更新系 API をブラウザ以外から叩く経路は無い（web-capture は Worker から
 * 呼ぶ側、cron は fetch ハンドラを持たない、Chrome 拡張は GET /api/me/ だけ）。
 * サーバー間で更新系を叩く経路を足す時は、Bearer 等の別認証で本判定を明示的に迂回する。
 */

import { ERROR_CODES, type ErrorResponse } from '../contracts/api';

/** 副作用を持たないメソッド。ブラウザは GET に `Origin` を付けないので判定対象外。 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * `Sec-Fetch-Site` で即拒否する値。
 *
 * `same-site` を含めるのは、兄弟サブドメインからの送信こそが防ぎたい経路だから
 * （SameSite=Lax の Cookie が付く範囲と一致する）。
 */
const REJECTED_FETCH_SITES: ReadonlySet<string> = new Set(['cross-site', 'same-site']);

/**
 * `Origin` の欠落を許す `Sec-Fetch-Site` の値。
 *
 * どちらもブラウザが「自分自身から」と保証する値で、JS からは偽装できない
 * （forbidden header name）。ヘッダー自体が無い（古いブラウザ・非ブラウザ）場合は
 * `Origin` の一致だけで判定する。
 */
const SELF_FETCH_SITES: ReadonlySet<string> = new Set(['same-origin', 'none']);

/** 判定結果。拒否理由は観測用の識別子だけ（URL や Origin の値は含めない）。 */
export type OriginCheckResult =
  | { ok: true }
  | { ok: false; reason: 'fetch_site_rejected' | 'origin_missing' | 'origin_mismatch' };

/** 更新系リクエストが自 origin 発かを判定する。安全なメソッドは常に通す。 */
export function checkMutationOrigin(request: Request, url: URL): OriginCheckResult {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return { ok: true };

  const fetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase() ?? null;
  if (fetchSite !== null && REJECTED_FETCH_SITES.has(fetchSite)) {
    return { ok: false, reason: 'fetch_site_rejected' };
  }

  const origin = request.headers.get('origin');
  if (origin === null) {
    // `Origin: null`（サンドボックス iframe・リダイレクト経由）は文字列 "null" で届くので
    // ここには来ず、下の不一致で落ちる。
    if (fetchSite !== null && SELF_FETCH_SITES.has(fetchSite)) return { ok: true };
    return { ok: false, reason: 'origin_missing' };
  }

  if (origin !== url.origin) return { ok: false, reason: 'origin_mismatch' };
  return { ok: true };
}

/** クロス origin の更新系リクエストへ返す 403 応答。全経路と同じ `ErrorResponse` の形。 */
export function crossOriginForbiddenResponse(): Response {
  const body: ErrorResponse = {
    errorCode: ERROR_CODES.forbidden,
    message: 'このリクエストは同一 origin からのみ受け付けます',
  };
  return Response.json(body, { status: 403, headers: { 'Cache-Control': 'no-store' } });
}
