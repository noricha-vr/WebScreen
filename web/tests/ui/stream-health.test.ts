import { describe, expect, test } from 'bun:test';

import {
  STREAM_HEALTH_MAX_ATTEMPTS,
  STREAM_HEALTH_POLL_INTERVAL_MS,
  waitForStreamReady,
} from '../../src/lib/ui/screen-share/stream-api';
import type { ScreenShareDependencies } from '../../src/lib/ui/screen-share';

describe('配信開始のhealth判定', () => {
  test('ingressとegressのbytesが連続して増えた時だけreadyにする', async () => {
    const responses = [
      { state: 'starting', ingressBytes: 0, egressBytes: 0, audioDetected: null },
      { state: 'ready', ingressBytes: 10, egressBytes: 5, audioDetected: null },
      { state: 'ready', ingressBytes: 20, egressBytes: 10, audioDetected: true },
    ];
    const waits: number[] = [];
    const request = (async () => responses.shift()) as unknown as ScreenShareDependencies['requestJson'];

    await expect(waitForStreamReady('Ab12Cd34Ef56', request, async (milliseconds) => {
      waits.push(milliseconds);
    })).resolves.toBe(true);
    expect(waits).toEqual([STREAM_HEALTH_POLL_INTERVAL_MS]);
  });

  test('bytesが増えなければ上限回数でstartingを打ち切る', async () => {
    let requests = 0;
    let waits = 0;
    const request = (async () => {
      requests += 1;
      return { state: 'ready', ingressBytes: 10, egressBytes: 5, audioDetected: null };
    }) as unknown as ScreenShareDependencies['requestJson'];

    await expect(waitForStreamReady('Ab12Cd34Ef56', request, async () => {
      waits += 1;
    })).resolves.toBe(false);
    expect(requests).toBe(STREAM_HEALTH_MAX_ATTEMPTS);
    expect(waits).toBe(STREAM_HEALTH_MAX_ATTEMPTS - 1);
  });

  test('health request待機中のabort後は次のrequestを送らない', async () => {
    const pendingRequest = deferred<Record<string, unknown>>();
    const abortController = new AbortController();
    let requests = 0;
    let receivedSignal: AbortSignal | undefined;
    const request = (async (_path: string, init: RequestInit) => {
      requests += 1;
      receivedSignal = init.signal as AbortSignal | undefined;
      return pendingRequest.promise;
    }) as unknown as ScreenShareDependencies['requestJson'];

    const result = waitForStreamReady('Ab12Cd34Ef56', request, async () => undefined, abortController.signal);
    await Promise.resolve();
    abortController.abort();
    pendingRequest.resolve({ state: 'starting', ingressBytes: 0, egressBytes: 0, audioDetected: null });

    await expect(result).resolves.toBe(false);
    expect(receivedSignal).toBe(abortController.signal);
    expect(requests).toBe(1);
  });

  test('poll delay待機中のabort後は次のrequestを送らない', async () => {
    const pendingDelay = deferred<void>();
    const abortController = new AbortController();
    let requests = 0;
    const request = (async () => {
      requests += 1;
      return { state: 'starting', ingressBytes: 0, egressBytes: 0, audioDetected: null };
    }) as unknown as ScreenShareDependencies['requestJson'];

    const result = waitForStreamReady(
      'Ab12Cd34Ef56',
      request,
      () => pendingDelay.promise,
      abortController.signal
    );
    await Promise.resolve();
    abortController.abort();
    pendingDelay.resolve();

    await expect(result).resolves.toBe(false);
    expect(requests).toBe(1);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
