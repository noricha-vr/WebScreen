import type {
  CreateStreamResponse,
  ExtendStreamResponse,
  StopLiveStreamsResponse,
  StreamHealthResponse,
} from '../../contracts/streams';
import { STREAM_START_TOKEN_HEADER } from '../../contracts/streams';
import { requestJson } from '../request-json';

export const STREAM_HEALTH_POLL_INTERVAL_MS = 1_000;
export const STREAM_HEALTH_MAX_ATTEMPTS = 10;

type JsonRequester = typeof requestJson;
type BeaconSender = (url: string, data?: BodyInit | null) => boolean;

/** 画面共有 controller が利用する stream HTTP 境界。 */
export interface StreamApi {
  create(startToken: string): Promise<CreateStreamResponse>;
  extend(id: string, signal: AbortSignal): Promise<ExtendStreamResponse>;
  stopLive(signal: AbortSignal): Promise<StopLiveStreamsResponse>;
  heartbeat(id: string, signal: AbortSignal): Promise<void>;
  waitForReady(id: string, signal?: AbortSignal): Promise<boolean>;
  stop(id: string, preferBeacon?: boolean): Promise<void>;
  cancelStart(startToken: string, preferBeacon?: boolean): Promise<void>;
}

/** requestJson と beacon を stream endpoint 群へ束ねる。 */
export function createStreamApi(
  request: JsonRequester,
  sendBeacon: BeaconSender,
  wait: (milliseconds: number) => Promise<void> = delay,
  readyOverride?: (id: string, signal?: AbortSignal) => Promise<boolean>
): StreamApi {
  return {
    async create(startToken) {
      // pagehide 後も late ID を回収して stop するため create 自体には signal を付けない。
      return asCreateStream(await request('/api/streams/', {
        method: 'POST',
        headers: { [STREAM_START_TOKEN_HEADER]: startToken },
      }));
    },
    async extend(id, signal) {
      return asExtendStream(await request(streamPath(id, 'extend'), { method: 'POST', signal }));
    },
    async stopLive(signal) {
      return asStopLiveStreams(await request('/api/streams/stop-live/', { method: 'POST', signal }));
    },
    async heartbeat(id, signal) {
      asNoContent(await request(streamPath(id, 'heartbeat'), { method: 'POST', signal }));
    },
    waitForReady(id, signal) {
      return readyOverride?.(id, signal) ?? waitForStreamReady(id, request, wait, signal);
    },
    async stop(id, preferBeacon = false) {
      const url = streamPath(id, 'stop');
      if (preferBeacon && queueBeacon(sendBeacon, url)) return;
      asNoContent(await request(url, { method: 'POST' }));
    },
    async cancelStart(startToken, preferBeacon = false) {
      const url = '/api/streams/cancel-start/';
      const body = JSON.stringify({ startToken });
      if (preferBeacon && queueBeacon(sendBeacon, url, body)) return;
      asNoContent(await request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }));
    },
  };
}

/** health bytes が連続観測で増えた時だけ ready と判定する。 */
export async function waitForStreamReady(
  streamId: string,
  request: JsonRequester,
  wait: (milliseconds: number) => Promise<void> = delay,
  signal?: AbortSignal
): Promise<boolean> {
  let previous: StreamHealthResponse | null = null;
  for (let attempt = 0; attempt < STREAM_HEALTH_MAX_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) return false;
    const current = asStreamHealth(await request(streamPath(streamId, 'health'), { signal }));
    if (signal?.aborted) return false;
    if (previous && current.state === 'ready' && bytesIncreased(previous, current)) return true;
    previous = current;
    if (attempt + 1 < STREAM_HEALTH_MAX_ATTEMPTS) {
      await wait(STREAM_HEALTH_POLL_INTERVAL_MS);
      if (signal?.aborted) return false;
    }
  }
  return false;
}

function bytesIncreased(previous: StreamHealthResponse, current: StreamHealthResponse): boolean {
  return current.ingressBytes > previous.ingressBytes && current.egressBytes > previous.egressBytes;
}

function queueBeacon(sendBeacon: BeaconSender, url: string, body?: string): boolean {
  try {
    const payload = body === undefined ? undefined : new Blob([body], { type: 'application/json' });
    return sendBeacon(url, payload);
  } catch (error) {
    console.warn('Failed to queue stream lifecycle beacon', error);
    return false;
  }
}

function streamPath(id: string, operation: 'extend' | 'heartbeat' | 'health' | 'stop'): string {
  return `/api/streams/${encodeURIComponent(id)}/${operation}/`;
}

function asCreateStream(value: unknown): CreateStreamResponse {
  if (!isRecord(value) || !hasStringFields(value, [
    'id', 'streamUrl', 'publishToken', 'publishTokenExpiresAt', 'extendExpiresAt',
    'startedAt', 'lastHeartbeatAt',
  ]) || value.status !== 'live' || value.endedAt !== null || value.endReason !== null) {
    throw new Error('Invalid create stream response');
  }
  return value as unknown as CreateStreamResponse;
}

function asExtendStream(value: unknown): ExtendStreamResponse {
  if (!isRecord(value) || !hasStringFields(value, [
    'id', 'publishToken', 'publishTokenExpiresAt', 'extendExpiresAt',
  ]) || value.status !== 'live') {
    throw new Error('Invalid extend stream response');
  }
  return value as unknown as ExtendStreamResponse;
}

function asStopLiveStreams(value: unknown): StopLiveStreamsResponse {
  if (!isRecord(value) || !isNonNegativeInteger(value.stopped) ||
      !isNonNegativeInteger(value.retryAfterSeconds)) {
    throw new Error('Invalid stop live streams response');
  }
  return value as unknown as StopLiveStreamsResponse;
}

function asStreamHealth(value: unknown): StreamHealthResponse {
  if (!isRecord(value) || (value.state !== 'starting' && value.state !== 'ready') ||
      !isNonNegativeNumber(value.ingressBytes) || !isNonNegativeNumber(value.egressBytes) ||
      (value.audioDetected !== null && typeof value.audioDetected !== 'boolean')) {
    throw new Error('Invalid stream health response');
  }
  return value as unknown as StreamHealthResponse;
}

function asNoContent(value: unknown): void {
  if (value !== null) throw new Error('Invalid no-content stream response');
}

function hasStringFields(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => typeof value[key] === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
