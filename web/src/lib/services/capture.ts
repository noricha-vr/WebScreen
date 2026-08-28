import {
  ERROR_CODES,
  type CaptureResponse,
  type ErrorResponse,
  validateCaptureRequest,
} from '../contracts/api';
import { logWorkerFailure } from '../infra/worker-log';
import { requireUser, type AuthDatabase } from './auth';

const CAPTURE_TIMEOUT_MS = 150_000;

const UPSTREAM_CAPTURE_ERROR_CODES = {
  pdfUrlNotSupported: 'pdf_url_not_supported',
  imageUrlNotSupported: 'image_url_not_supported',
  videoUrlNotSupported: 'video_url_not_supported',
  nonWebPageUrl: 'non_web_page_url',
  captureLimitExceeded: 'capture_limit_exceeded',
  captureTimeout: 'capture_timeout',
} as const;

const CAPTURE_ERROR_CODE_MAP: Readonly<
  Record<string, { status: number; errorCode: ErrorResponse['errorCode']; message: string }>
> = {
  [UPSTREAM_CAPTURE_ERROR_CODES.pdfUrlNotSupported]: {
    status: 422,
    errorCode: ERROR_CODES.pdfUrlNotSupported,
    message: '指定した URL は変換できません',
  },
  [UPSTREAM_CAPTURE_ERROR_CODES.imageUrlNotSupported]: {
    status: 422,
    errorCode: ERROR_CODES.imageUrlNotSupported,
    message: '指定した URL は変換できません',
  },
  [UPSTREAM_CAPTURE_ERROR_CODES.videoUrlNotSupported]: {
    status: 422,
    errorCode: ERROR_CODES.videoUrlNotSupported,
    message: '指定した URL は変換できません',
  },
  [UPSTREAM_CAPTURE_ERROR_CODES.nonWebPageUrl]: {
    status: 422,
    errorCode: ERROR_CODES.nonWebPageUrl,
    message: '指定した URL は変換できません',
  },
  [UPSTREAM_CAPTURE_ERROR_CODES.captureLimitExceeded]: {
    status: 400,
    errorCode: ERROR_CODES.pageTooLong,
    message: 'ページが長すぎるため変換できません',
  },
  [UPSTREAM_CAPTURE_ERROR_CODES.captureTimeout]: {
    status: 504,
    errorCode: ERROR_CODES.captureTimeout,
    message: 'キャプチャサービスがタイムアウトしました',
  },
};

/** web-capture 呼び出しをテストから差し替えるための fetch 境界。 */
export type CaptureFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** capture プロキシが必要とする Worker binding。 */
export interface CaptureBindings {
  database: AuthDatabase;
  signingKey: CryptoKey;
  webCaptureUrl: string;
  webCaptureToken: string;
}

/** テスト用依存を含む capture プロキシ設定。 */
export interface CaptureProxyDependencies extends CaptureBindings {
  fetcher?: CaptureFetcher;
  nowSeconds?: number;
  timeoutMs?: number;
}

/** 認証済みの capture リクエストを web-capture サービスへ転送する。 */
export async function proxyCapture(
  request: Request,
  deps: CaptureProxyDependencies
): Promise<Response> {
  const user = await requireUser(request, {
    db: deps.database,
    signingKey: deps.signingKey,
    nowSeconds: deps.nowSeconds,
  });
  if (!user.ok) return json(user.error, user.status);

  const validation = validateCaptureRequest(await readJson(request));
  if (!validation.ok) return json(validation.error, 400);
  if (!isPublicCaptureUrl(validation.value.url)) {
    return errorResponse(400, ERROR_CODES.captureFailed, 'url はローカルまたはプライベートネットワークを指定できません');
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Capture request timed out', 'TimeoutError')),
    deps.timeoutMs ?? CAPTURE_TIMEOUT_MS
  );

  try {
    const upstream = await (deps.fetcher ?? defaultFetch)(
      `${deps.webCaptureUrl}/capture`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${deps.webCaptureToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(validation.value),
        signal: controller.signal,
      }
    );
    const body = await readResponseJson(upstream);
    if (!upstream.ok) return captureErrorResponse(upstream.status, body);
    if (!isCaptureResponse(body)) {
      logWorkerFailure({
        event: 'capture_upstream_response_invalid',
        errorCode: ERROR_CODES.captureFailed,
        status: 502,
        upstreamStatus: upstream.status,
      });
      return captureFailedResponse();
    }
    return json(body, 200);
  } catch {
    if (controller.signal.aborted) {
      logWorkerFailure({
        event: 'capture_worker_timeout',
        errorCode: ERROR_CODES.captureTimeout,
        status: 504,
      });
      return errorResponse(504, ERROR_CODES.captureTimeout, 'キャプチャサービスがタイムアウトしました');
    }
    logWorkerFailure({
      event: 'capture_upstream_request_failed',
      errorCode: ERROR_CODES.captureFailed,
      status: 502,
    });
    return captureFailedResponse();
  } finally {
    clearTimeout(timeout);
  }
}

// workerd ではグローバル fetch をデフォルト引数に束縛すると Illegal invocation になる。
const defaultFetch: CaptureFetcher = (input, init) => globalThis.fetch(input, init);

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    logWorkerFailure({
      level: 'warn',
      event: 'capture_request_json_invalid',
      errorCode: ERROR_CODES.invalidRequest,
      status: 400,
    });
    return null;
  }
}

function isPublicCaptureUrl(value: string): boolean {
  const parsed = new URL(value);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');

  if (isLocalhostName(hostname)) return false;
  if (isPrivateIpv4(hostname)) return false;
  if (isPrivateIpv6(hostname)) return false;
  return true;
}

function isLocalhostName(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.startsWith('localhost.') ||
    hostname.endsWith('.localhost') ||
    hostname === 'ip6-localhost'
  );
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d+$/.test(octet))) return false;

  const values = octets.map(Number);
  if (values.some((value) => value > 255)) return false;
  const [first, second] = values as [number, number, number, number];
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.includes(':')) return false;
  if (hostname === '::' || hostname === '::1') return true;

  const embeddedIpv4 = hostname.slice(hostname.lastIndexOf(':') + 1);
  if (embeddedIpv4.includes('.') && isPrivateIpv4(embeddedIpv4)) return true;

  const mappedIpv4 = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedIpv4) {
    const [high, low] = mappedIpv4.slice(1).map((part) => Number.parseInt(part, 16));
    if (high !== undefined && low !== undefined) {
      const ipv4 = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
      if (isPrivateIpv4(ipv4)) return true;
    }
  }

  return /^(?:fc|fd)[0-9a-f]{2}(?::|$)/.test(hostname) || /^fe[89ab][0-9a-f](?::|$)/.test(hostname);
}

function isCaptureResponse(value: unknown): value is CaptureResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as CaptureResponse).images) &&
    (value as CaptureResponse).images.every((image) => typeof image === 'string')
  );
}

function captureFailedResponse(): Response {
  return errorResponse(502, ERROR_CODES.captureFailed, 'キャプチャサービスへのリクエストに失敗しました');
}

function captureErrorResponse(status: number, body: unknown): Response {
  const error = captureErrorCode(body);
  if (error?.status === status) {
    logWorkerFailure({
      level: 'warn',
      event: 'capture_upstream_rejected',
      errorCode: error.errorCode,
      status,
    });
    return errorResponse(status, error.errorCode, error.message);
  }

  logWorkerFailure({
    event: 'capture_upstream_error_unmapped',
    errorCode: ERROR_CODES.captureFailed,
    status: 502,
    upstreamStatus: status,
  });
  return captureFailedResponse();
}

function captureErrorCode(body: unknown): (typeof CAPTURE_ERROR_CODE_MAP)[string] | null {
  if (!isRecord(body) || typeof body.errorCode !== 'string') return null;
  return CAPTURE_ERROR_CODE_MAP[body.errorCode] ?? null;
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    // 非 JSON のエラー応答は captureErrorResponse が 1 回だけ記録する。
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorResponse(status: number, errorCode: ErrorResponse['errorCode'], message: string): Response {
  const body: ErrorResponse = { errorCode, message };
  return json(body, status);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
