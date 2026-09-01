import type { StreamHealthResponse } from '../contracts/api';
import { requestJson } from './request-json';

export const STREAM_HEALTH_POLL_INTERVAL_MS = 1_000;
export const STREAM_HEALTH_MAX_ATTEMPTS = 10;

/** ingress と egress の受信bytesが連続観測で増えた時だけ配信開始と判定する。 */
export async function waitForStreamReady(
  streamId: string,
  request: typeof requestJson,
  wait: (milliseconds: number) => Promise<void> = delay
): Promise<boolean> {
  let previous: StreamHealthResponse | null = null;
  for (let attempt = 0; attempt < STREAM_HEALTH_MAX_ATTEMPTS; attempt += 1) {
    const current = asStreamHealth(
      await request(`/api/streams/${encodeURIComponent(streamId)}/health/`, {})
    );
    if (
      previous &&
      current.state === 'ready' &&
      current.ingressBytes > previous.ingressBytes &&
      current.egressBytes > previous.egressBytes
    ) {
      return true;
    }
    previous = current;
    if (attempt + 1 < STREAM_HEALTH_MAX_ATTEMPTS) {
      await wait(STREAM_HEALTH_POLL_INTERVAL_MS);
    }
  }
  return false;
}

function asStreamHealth(value: unknown): StreamHealthResponse {
  if (
    !isRecord(value) ||
    (value.state !== 'starting' && value.state !== 'ready') ||
    typeof value.ingressBytes !== 'number' ||
    typeof value.egressBytes !== 'number' ||
    (value.audioDetected !== null && typeof value.audioDetected !== 'boolean')
  ) {
    throw new Error('Invalid stream health response');
  }
  return value as unknown as StreamHealthResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}
