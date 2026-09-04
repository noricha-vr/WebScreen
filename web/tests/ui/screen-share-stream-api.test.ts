import { describe, expect, test } from 'bun:test';

import { createStreamApi } from '../../src/lib/ui/screen-share/stream-api';
import type { ScreenShareDependencies } from '../../src/lib/ui/screen-share';

describe('画面共有 stream API のHTTP契約', () => {
  test('createはPOSTと開始token headerを固定する', async () => {
    const state = recordingApi();
    await state.api.create(START_TOKEN);

    expect(state.calls).toEqual([{
      url: '/api/streams/',
      init: { method: 'POST', headers: { 'X-WebScreen-Start-Token': START_TOKEN } },
    }]);
  });

  test('createは再利用 ID がある時だけ JSON body を送る', async () => {
    const state = recordingApi();
    await state.api.create(START_TOKEN, 'Ab12Cd34Ef56');

    expect(state.calls).toEqual([{
      url: '/api/streams/',
      init: {
        method: 'POST',
        headers: {
          'X-WebScreen-Start-Token': START_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id: 'Ab12Cd34Ef56' }),
      },
    }]);
  });

  test('stop-live・heartbeatはPOSTとsignalを固定しIDをencodeする', async () => {
    const state = recordingApi();
    const signal = new AbortController().signal;
    await state.api.stopLive(signal);
    await state.api.heartbeat('Ab/12', signal);

    expect(state.calls).toEqual([
      { url: '/api/streams/stop-live/', init: { method: 'POST', signal } },
      { url: '/api/streams/Ab%2F12/heartbeat/', init: { method: 'POST', signal } },
    ]);
  });

  test('extendはPOSTとencode済みIDで期限・publish tokenを受け取る', async () => {
    const state = recordingApi();
    await expect(state.api.extend('Ab/12')).resolves.toMatchObject({
      id: 'Ab/12', extendExpiresAt: '2026-09-01T02:00:00.000Z',
    });
    expect(state.calls).toEqual([{ url: '/api/streams/Ab%2F12/extend/', init: { method: 'POST' } }]);
  });

  test('healthはencode済みIDのGETを同じsignalでpollする', async () => {
    const state = recordingApi();
    const signal = new AbortController().signal;
    await expect(state.api.waitForReady('Ab/12', signal)).resolves.toBe(true);

    expect(state.calls).toEqual([
      { url: '/api/streams/Ab%2F12/health/', init: { signal } },
      { url: '/api/streams/Ab%2F12/health/', init: { signal } },
    ]);
  });

  test('stopはbeacon成功時にfetchせず、false時はPOSTへfallbackする', async () => {
    const queued = recordingApi({ beaconResult: true });
    await queued.api.stop('Ab/12', true);
    expect(queued.beacons).toEqual([{ url: '/api/streams/Ab%2F12/stop/', data: undefined }]);
    expect(queued.calls).toEqual([]);

    const fallback = recordingApi({ beaconResult: false });
    await fallback.api.stop('Ab/12', true);
    expect(fallback.beacons).toEqual([{ url: '/api/streams/Ab%2F12/stop/', data: undefined }]);
    expect(fallback.calls).toEqual([{
      url: '/api/streams/Ab%2F12/stop/',
      init: { method: 'POST' },
    }]);
  });

  test('cancel-startはbeacon成功時にJSON Blobだけを送り、false時はkeepalive POSTする', async () => {
    const queued = recordingApi({ beaconResult: true });
    await queued.api.cancelStart(START_TOKEN, true);
    expect(queued.calls).toEqual([]);
    expect(queued.beacons[0]?.url).toBe('/api/streams/cancel-start/');
    const queuedBody = queued.beacons[0]?.data;
    expect(queuedBody).toBeInstanceOf(Blob);
    expect(await (queuedBody as Blob).text()).toBe(JSON.stringify({ startToken: START_TOKEN }));
    expect((queuedBody as Blob).type.startsWith('application/json')).toBe(true);

    const fallback = recordingApi({ beaconResult: false });
    await fallback.api.cancelStart(START_TOKEN, true);
    expect(fallback.calls).toEqual([{
      url: '/api/streams/cancel-start/',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startToken: START_TOKEN }),
        keepalive: true,
      },
    }]);
  });
});

describe('画面共有 stream API の応答検証', () => {
  test.each([
    null,
    { id: 'Ab12Cd34Ef56' },
    { ...createResponse(), whipUrl: null },
    { ...createResponse(), whipUrl: 'http://webscreen.tv/live/Ab12Cd34Ef56/whip' },
    { ...createResponse(), whipUrl: 'https://webscreen.tv/live/OtherId12345/whip' },
    { ...createResponse(), whipUrl: 'https://user:pw@webscreen.tv/live/Ab12Cd34Ef56/whip' },
    { ...createResponse(), whipUrl: 'https://webscreen.tv/live/Ab12Cd34Ef56/other' },
    { ...createResponse(), status: 'ended' },
    { ...createResponse(), endedAt: '2026-09-01T00:01:00.000Z' },
  ])('createの不正応答を拒否する', async (response) => {
    const api = apiReturning(response);
    await expect(api.create(START_TOKEN)).rejects.toThrow('Invalid create stream response');
  });

  test.each([
    { stopped: -1, retryAfterSeconds: 3 },
    { stopped: 1, retryAfterSeconds: 1.5 },
  ])('stop-liveの不正応答を拒否する', async (response) => {
    const api = apiReturning(response);
    await expect(api.stopLive(new AbortController().signal))
      .rejects.toThrow('Invalid stop live streams response');
  });

  test('cancel-startの204以外の成功本文を拒否する', async () => {
    const api = apiReturning({ cancelled: true });
    await expect(api.cancelStart(START_TOKEN)).rejects.toThrow('Invalid no-content stream response');
  });

  test.each([
    { state: 'unknown', ingressBytes: 0, egressBytes: 0, audioDetected: null },
    { state: 'ready', ingressBytes: -1, egressBytes: 0, audioDetected: null },
    { state: 'ready', ingressBytes: 1, egressBytes: 1, audioDetected: 'yes' },
  ])('healthの不正応答を拒否する', async (response) => {
    const api = apiReturning(response);
    await expect(api.waitForReady('Ab12Cd34Ef56')).rejects.toThrow('Invalid stream health response');
  });

  test.each([
    null,
    { id: 'Ab12Cd34Ef56', status: 'live' },
    { id: 'Ab12Cd34Ef56', status: 'ended', publishToken: 'token', publishTokenExpiresAt: 'x', extendExpiresAt: 'x' },
    { ...extendResponse(), id: 'OtherId12345' },
    { ...extendResponse(), publishToken: '' },
    { ...extendResponse(), publishTokenExpiresAt: 'not-a-date', extendExpiresAt: 'not-a-date' },
    { ...extendResponse(), extendExpiresAt: 'not-a-date' },
    { ...extendResponse(), extendExpiresAt: '2026-09-01T03:00:00.000Z' },
  ])('extendの不正応答を拒否する', async (response) => {
    await expect(apiReturning(response).extend('Ab12Cd34Ef56')).rejects.toThrow('Invalid extend stream response');
  });
});

const START_TOKEN = 'test-start-token';

interface ApiCall {
  url: string;
  init: RequestInit;
}

function recordingApi(options: { beaconResult?: boolean } = {}) {
  const calls: ApiCall[] = [];
  const beacons: Array<{ url: string; data?: BodyInit | null }> = [];
  let healthCalls = 0;
  const request = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === '/api/streams/') return createResponse();
    if (url === '/api/streams/stop-live/') return { stopped: 1, retryAfterSeconds: 3 };
    if (url.endsWith('/extend/')) return { ...extendResponse(), id: 'Ab/12' };
    if (url.endsWith('/health/')) {
      healthCalls += 1;
      return {
        state: healthCalls === 1 ? 'starting' : 'ready',
        ingressBytes: healthCalls,
        egressBytes: healthCalls,
        audioDetected: null,
      };
    }
    return null;
  }) as unknown as ScreenShareDependencies['requestJson'];
  const sendBeacon = (url: string, data?: BodyInit | null): boolean => {
    beacons.push({ url, data });
    return options.beaconResult ?? false;
  };
  return {
    api: createStreamApi(request, sendBeacon, async () => undefined),
    calls,
    beacons,
  };
}

function apiReturning(response: unknown) {
  const request = (async () => response) as unknown as ScreenShareDependencies['requestJson'];
  return createStreamApi(request, () => false, async () => undefined);
}

function extendResponse(): Record<string, unknown> {
  return {
    id: 'Ab12Cd34Ef56',
    status: 'live',
    publishToken: 'extended-token',
    publishTokenExpiresAt: '2026-09-01T02:00:00.000Z',
    extendExpiresAt: '2026-09-01T02:00:00.000Z',
  };
}

function createResponse(): Record<string, unknown> {
  return {
    id: 'Ab12Cd34Ef56',
    streamUrl: 'rtspt://webscreen.tv/live/Ab12Cd34Ef56',
    whipUrl: 'https://webscreen.tv/live/Ab12Cd34Ef56/whip',
    status: 'live',
    publishToken: 'token',
    publishTokenExpiresAt: '2026-09-01T01:00:00.000Z',
    extendExpiresAt: '2026-09-01T01:00:00.000Z',
    startedAt: '2026-09-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-09-01T00:00:00.000Z',
    endedAt: null,
    endReason: null,
  };
}
