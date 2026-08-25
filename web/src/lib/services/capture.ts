import {
  ERROR_CODES,
  type CaptureResponse,
  type ErrorResponse,
  validateCaptureRequest,
} from '../contracts/api';
import { requireUser, type AuthDatabase } from './auth';

const CAPTURE_TIMEOUT_MS = 150_000;

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
    return errorResponse(400, 'url はローカルまたはプライベートネットワークを指定できません');
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
    if (!upstream.ok) return captureFailedResponse();

    const body = await upstream.json();
    if (!isCaptureResponse(body)) return captureFailedResponse();
    return json(body, 200);
  } catch {
    if (controller.signal.aborted) {
      return errorResponse(504, 'キャプチャサービスがタイムアウトしました');
    }
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
  return errorResponse(502, 'キャプチャサービスへのリクエストに失敗しました');
}

function errorResponse(status: number, message: string): Response {
  const body: ErrorResponse = { errorCode: ERROR_CODES.captureFailed, message };
  return json(body, status);
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
