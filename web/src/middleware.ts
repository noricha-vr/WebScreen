import type { MiddlewareHandler } from 'astro';

import { ERROR_CODES } from './lib/contracts/api';
import { logWorkerFailure } from './lib/observability/worker-log';
import {
  checkMutationOrigin,
  crossOriginForbiddenResponse,
} from './lib/services/request-origin';

/**
 * COOP/COEP を SSR / server endpoint のレスポンスに付与する。
 *
 * public/_headers は Static Assets の配信にしか適用されず、Worker が生成した
 * レスポンス（prerender=false のページ・API ルート）には効かない。
 * FFmpeg.wasm の SharedArrayBuffer は crossOriginIsolated を要求するため、
 * 静的・動的の両経路で同じヘッダーを配る必要がある（_headers と本ファイルの二重化）。
 */
const CROSS_ORIGIN_ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function withIsolationHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(CROSS_ORIGIN_ISOLATION_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

/**
 * 更新系リクエストのクロス origin 拒否（CSRF 対策）と、応答ヘッダーの付与。
 *
 * Origin 検証はハンドラより前に行う（Cookie 認証の更新系 API が共通で通る唯一の境界）。
 * prerender されたページは build 時にここを通るだけで、実行時は Static Assets が配るため
 * 対象外にする（Astro 自身の checkOrigin と同じ扱い）。
 * 判定の詳細は lib/services/request-origin.ts。
 */
export const onRequest: MiddlewareHandler = async (context, next) => {
  if (!context.isPrerendered) {
    const verdict = checkMutationOrigin(context.request, context.url);
    if (!verdict.ok) {
      logWorkerFailure({
        level: 'warn',
        event: 'cross_origin_mutation_rejected',
        errorCode: ERROR_CODES.forbidden,
        status: 403,
        reason: verdict.reason,
      });
      return withIsolationHeaders(crossOriginForbiddenResponse());
    }
  }

  return withIsolationHeaders(await next());
};
