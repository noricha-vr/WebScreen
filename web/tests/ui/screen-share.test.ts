import { describe, expect, test } from 'bun:test';

import {
  EXPIRY_WARNING_SECONDS,
  HEARTBEAT_INTERVAL_MS,
  isExpiryWarning,
  nextStreamStep,
  releaseScreenShare,
  ScreenShareController,
  secondsUntil,
} from '../../src/lib/ui/screen-share';
import type { ScreenShareDependencies } from '../../src/lib/ui/screen-share';
import type { WhipPublisher } from '../../src/lib/ui/whip-publisher';

describe('画面共有ウィザードの状態', () => {
  test('配信 URL の確認後だけライブ画面へ進める', () => {
    expect(nextStreamStep('url')).toBe('live');
    expect(nextStreamStep('live')).toBeNull();
  });
});

describe('配信のタイマー', () => {
  test('heartbeat はサーバーの 60 秒タイムアウトより短い 25 秒間隔で送る', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(25_000);
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(60_000);
  });

  test('延長期限の残り時間と5分前の警告を境界どおり計算する', () => {
    const now = Date.parse('2026-09-01T00:00:00.000Z');
    const warningAt = new Date(now + EXPIRY_WARNING_SECONDS * 1000).toISOString();
    const later = new Date(now + (EXPIRY_WARNING_SECONDS + 1) * 1000).toISOString();

    expect(secondsUntil(warningAt, now)).toBe(EXPIRY_WARNING_SECONDS);
    expect(isExpiryWarning(warningAt, now)).toBe(true);
    expect(isExpiryWarning(later, now)).toBe(false);
  });
});

describe('配信の後始末', () => {
  test('ネットワークを待たずにタイマー・画面共有・PeerConnection をこの順で止める', () => {
    const released: string[] = [];
    releaseScreenShare(
      {
        publisher: {
          close: () => { released.push('peerConnection'); },
          deleteResource: async () => undefined,
          setPublishToken: () => undefined,
        },
        media: { getTracks: () => [{ stop: () => { released.push('media'); } }] } as unknown as MediaStream,
      },
      () => { released.push('timers'); }
    );

    expect(released).toEqual(['timers', 'media', 'peerConnection']);
  });
});

describe('画面共有 controller', () => {
  test('開始クリックから URL・配信中を経て停止クリックでローカル資源を解放する', async () => {
    const calls: string[] = [];
    let stopped = 0;
    let closed = 0;
    let deleted = 0;
    const page = fakeScreenSharePage();
    const publisher: WhipPublisher = {
      close: () => { closed += 1; },
      deleteResource: async () => { deleted += 1; },
      setPublishToken: () => undefined,
    };
    const videoTrack = {
      addEventListener: () => undefined,
      stop: () => { stopped += 1; },
    };
    const media = {
      getTracks: () => [videoTrack],
      getVideoTracks: () => [videoTrack],
    } as unknown as MediaStream;
    const dependencies: ScreenShareDependencies = {
      requestJson: (async (path: string) => {
        calls.push(path);
        if (path === '/api/streams/') {
          return {
            id: 'Ab12Cd34Ef56', streamUrl: 'rtspt://webscreen.tv/live/Ab12Cd34Ef56',
            status: 'live', publishToken: 'initial-token',
            publishTokenExpiresAt: '2026-09-01T01:00:00.000Z',
            extendExpiresAt: '2026-09-01T01:00:00.000Z',
            startedAt: '2026-09-01T00:00:00.000Z', lastHeartbeatAt: '2026-09-01T00:00:00.000Z',
            endedAt: null, endReason: null,
          };
        }
        return null;
      }) as unknown as ScreenShareDependencies['requestJson'],
      startWhipPublisher: async () => publisher,
      getDisplayMedia: async () => media,
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
      sendBeacon: () => true,
      onPageHide: () => undefined,
    };
    const controller = new ScreenShareController(page.root, dependencies);
    controller.mount();

    page.button('[data-screen-start]').click();
    expect(page.step('select').hidden).toBe(false);

    page.button('[data-screen-select]').click();
    await waitFor(() => !page.step('url').hidden);
    expect(page.url.value).toBe('rtspt://webscreen.tv/live/Ab12Cd34Ef56');

    page.button('[data-screen-show-live]').click();
    expect(page.step('live').hidden).toBe(false);

    page.button('[data-screen-stop]').click();
    page.button('[data-screen-stop]').click();
    expect(closed).toBe(1);
    expect(stopped).toBe(1);
    expect(deleted).toBe(1);
    expect(page.step('idle').hidden).toBe(false);
    expect(calls).toEqual(['/api/streams/', '/api/streams/Ab12Cd34Ef56/stop/']);
  });

  test('pagehide では空 body の sendBeacon で停止を通知する', async () => {
    const page = fakeScreenSharePage();
    const beaconUrls: string[] = [];
    let pageHide: (() => void) | undefined;
    let stopped = 0;
    const publisher: WhipPublisher = {
      close: () => undefined,
      deleteResource: async () => undefined,
      setPublishToken: () => undefined,
    };
    const videoTrack = { addEventListener: () => undefined, stop: () => { stopped += 1; } };
    const media = {
      getTracks: () => [videoTrack],
      getVideoTracks: () => [videoTrack],
    } as unknown as MediaStream;
    const dependencies: ScreenShareDependencies = {
      requestJson: (async () => createResponse()) as unknown as ScreenShareDependencies['requestJson'],
      startWhipPublisher: async () => publisher,
      getDisplayMedia: async () => media,
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
      sendBeacon: (url) => { beaconUrls.push(url); return true; },
      onPageHide: (handler) => { pageHide = handler; },
    };
    new ScreenShareController(page.root, dependencies).mount();

    page.button('[data-screen-start]').click();
    page.button('[data-screen-select]').click();
    await waitFor(() => !page.step('url').hidden);
    pageHide?.();

    expect(beaconUrls).toEqual(['/api/streams/Ab12Cd34Ef56/stop/']);
    expect(stopped).toBe(1);
  });

  test('停止後に遅延した延長失敗が届いても error カードへ戻さない', async () => {
    const page = fakeScreenSharePage();
    const calls: string[] = [];
    const delayedExtend = deferred<never>();
    let closed = 0;
    let deleted = 0;
    let stopped = 0;
    const publisher: WhipPublisher = {
      close: () => { closed += 1; },
      deleteResource: async () => { deleted += 1; },
      setPublishToken: () => undefined,
    };
    const track = { addEventListener: () => undefined, stop: () => { stopped += 1; } };
    const media = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
    const dependencies: ScreenShareDependencies = {
      requestJson: ((path: string) => {
        calls.push(path);
        if (path === '/api/streams/') return Promise.resolve(createResponse());
        if (path.endsWith('/extend/')) return delayedExtend.promise;
        return Promise.resolve(null);
      }) as unknown as ScreenShareDependencies['requestJson'],
      startWhipPublisher: async () => publisher,
      getDisplayMedia: async () => media,
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
      sendBeacon: () => true,
      onPageHide: () => undefined,
    };
    const controller = new ScreenShareController(page.root, dependencies);
    controller.mount();
    page.button('[data-screen-start]').click();
    page.button('[data-screen-select]').click();
    await waitFor(() => !page.step('url').hidden);
    page.button('[data-screen-show-live]').click();
    page.button('[data-screen-extend]').click();
    await waitFor(() => calls.some((path) => path.endsWith('/extend/')));

    page.button('[data-screen-stop]').click();
    delayedExtend.reject(new Error('late failure'));
    await flushMicrotasks();

    expect(page.step('idle').hidden).toBe(false);
    expect(page.step('error').hidden).toBe(true);
    expect(closed).toBe(1);
    expect(deleted).toBe(1);
    expect(stopped).toBe(1);
  });

  test('pagehide が画面選択中でも後から取得された track を即座に停止する', async () => {
    const page = fakeScreenSharePage();
    const pendingMedia = deferred<MediaStream>();
    let pageHide: (() => void) | undefined;
    let stopped = 0;
    let createRequests = 0;
    let publisherStarts = 0;
    const track = { addEventListener: () => undefined, stop: () => { stopped += 1; } };
    const media = { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream;
    const dependencies: ScreenShareDependencies = {
      requestJson: (async () => {
        createRequests += 1;
        return createResponse();
      }) as unknown as ScreenShareDependencies['requestJson'],
      startWhipPublisher: async () => {
        publisherStarts += 1;
        throw new Error('publisher should not start');
      },
      getDisplayMedia: () => pendingMedia.promise,
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
      sendBeacon: () => true,
      onPageHide: (handler) => { pageHide = handler; },
    };
    new ScreenShareController(page.root, dependencies).mount();

    page.button('[data-screen-start]').click();
    page.button('[data-screen-select]').click();
    pageHide?.();
    pendingMedia.resolve(media);
    await flushMicrotasks();

    expect(stopped).toBe(1);
    expect(createRequests).toBe(0);
    expect(publisherStarts).toBe(0);
  });
});

function createResponse(): Record<string, unknown> {
  return {
    id: 'Ab12Cd34Ef56', streamUrl: 'rtspt://webscreen.tv/live/Ab12Cd34Ef56', status: 'live',
    publishToken: 'initial-token', publishTokenExpiresAt: '2026-09-01T01:00:00.000Z',
    extendExpiresAt: '2026-09-01T01:00:00.000Z', startedAt: '2026-09-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-09-01T00:00:00.000Z', endedAt: null, endReason: null,
  };
}

function fakeScreenSharePage(): {
  root: HTMLElement;
  button: (selector: string) => FakeElement;
  step: (phase: string) => FakeElement;
  url: FakeElement;
} {
  const elements = new Map<string, FakeElement>();
  for (const selector of [
    '[data-screen-start]', '[data-screen-select]', '[data-screen-copy]', '[data-screen-show-live]',
    '[data-screen-extend]', '[data-screen-stop]', '[data-screen-retry]', '[data-screen-url]',
    '[data-screen-preview]', '[data-screen-elapsed]', '[data-screen-expires]',
    '[data-screen-expiry-warning]', '[data-screen-error-message]',
  ]) elements.set(selector, new FakeElement());
  const steps = ['idle', 'select', 'login', 'url', 'live', 'error'].map((phase) => {
    const step = new FakeElement();
    step.dataset.screenStep = phase;
    return step;
  });
  const indicators = ['1', '2', '3'].map((value) => {
    const indicator = new FakeElement();
    indicator.dataset.screenIndicator = value;
    return indicator;
  });
  const root = {
    dataset: {
      labelSelect: 'select', labelSelecting: 'selecting', labelCopy: 'copy', labelCopied: 'copied',
      labelExtend: 'extend', labelExtending: 'extending', labelStop: 'stop', labelStopping: 'stopping',
      msgGeneric: 'error', msgH264: 'h264', msgWhip: 'whip', msgDisplayDenied: 'denied',
      msgStreamAlreadyLive: 'already-live', msgRateLimited: 'rate-limited', msgStreamEnded: 'ended',
    },
    querySelector: (selector: string) => elements.get(selector) ?? null,
    querySelectorAll: (selector: string) => {
      if (selector === '[data-screen-step]') return steps;
      if (selector === '[data-screen-indicator]') return indicators;
      return [];
    },
  } as unknown as HTMLElement;
  return {
    root,
    button: (selector) => elements.get(selector)!,
    step: (phase) => steps.find((step) => step.dataset.screenStep === phase)!,
    url: elements.get('[data-screen-url]')!,
  };
}

class FakeElement {
  dataset: Record<string, string> = {};
  disabled = false;
  hidden = false;
  srcObject: MediaProvider | null = null;
  textContent = '';
  value = '';
  private readonly listeners: Array<() => void> = [];

  addEventListener(event: string, listener: () => void): void {
    if (event === 'click') this.listeners.push(listener);
  }

  click(): void {
    for (const listener of this.listeners) listener();
  }
}

type MediaProvider = MediaStream | null;

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error('Expected asynchronous UI update');
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
