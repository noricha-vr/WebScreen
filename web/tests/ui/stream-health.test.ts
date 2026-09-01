import { describe, expect, test } from 'bun:test';

import {
  STREAM_HEALTH_MAX_ATTEMPTS,
  STREAM_HEALTH_POLL_INTERVAL_MS,
  waitForStreamReady,
} from '../../src/lib/ui/stream-health';
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
});
