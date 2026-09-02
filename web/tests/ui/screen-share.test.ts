import { describe, expect, test } from 'bun:test';

import {
  EXPIRY_WARNING_SECONDS,
  HEARTBEAT_INTERVAL_MS,
  isExpiryWarning,
  releaseScreenShare,
  ScreenShareController,
  secondsUntil,
} from '../../src/lib/ui/screen-share';
import type { ScreenShareDependencies } from '../../src/lib/ui/screen-share';
import type { WhipPublisher } from '../../src/lib/ui/whip-publisher';

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
          stop: async () => undefined,
          republish: async () => { throw new Error('not used'); },
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
  test('開始クリックから URL を含むライブ画面へ直接進み、停止でローカル資源を解放する', async () => {
    const calls: string[] = [];
    let stopped = 0;
    let closed = 0;
    let deleted = 0;
    let requestedConstraints: MediaStreamConstraints | undefined;
    let publishedInput: Parameters<ScreenShareDependencies['startWhipPublisher']>[0] | undefined;
    const page = fakeScreenSharePage();
    const publisher: WhipPublisher = {
      close: () => { closed += 1; },
      deleteResource: async () => { deleted += 1; },
      stop: async () => undefined,
      republish: async () => { throw new Error('not used'); },
      setPublishToken: () => undefined,
    };
    const videoTrack = {
      addEventListener: () => undefined,
      stop: () => { stopped += 1; },
    };
    const audioTrack = { contentHint: '', stop: () => { stopped += 1; }, getSettings: () => ({ channelCount: 2 }) };
    const media = {
      getTracks: () => [videoTrack, audioTrack],
      getVideoTracks: () => [videoTrack],
      getAudioTracks: () => [audioTrack],
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
      startWhipPublisher: async (input) => {
        publishedInput = input;
        return publisher;
      },
      waitForStreamReady: async () => true,
      getDisplayMedia: async (constraints) => {
        requestedConstraints = constraints;
        return media;
      },
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
      sendBeacon: () => true,
      onPageHide: () => undefined,
    };
    const controller = new ScreenShareController(page.root, dependencies);
    controller.mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('live').hidden);
    expect(page.url.value).toBe('rtspt://webscreen.tv/live/Ab12Cd34Ef56');
    expect(page.button('[data-screen-audio-status]').textContent).toBe('audio-included');
    expect(page.button('[data-screen-audio-chip]').dataset.audio).toBe('on');
    expect(page.button('[data-screen-audio-label]').textContent).toBe('audio-on');
    expect(page.button('[data-screen-audio-icon]').className).toBe('fa-solid fa-volume-high');
    // クエリなし = 既定の raw なので、音声処理を切る制約と raw プロファイルで publish する。
    expect(requestedConstraints).toEqual({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    });
    expect(publishedInput?.audioProfile).toBe('raw');
    expect(audioTrack.contentHint).toBe('music');

    page.button('[data-screen-stop]').click();
    page.button('[data-screen-stop]').click();
    expect(closed).toBe(1);
    expect(stopped).toBe(2);
    expect(deleted).toBe(1);
    expect(page.step('idle').hidden).toBe(false);
    expect(calls).toEqual(['/api/streams/', '/api/streams/Ab12Cd34Ef56/stop/']);
  });

  test.each(['resolve', 'reject'] as const)(
    '初回health待機中のpagehideで即停止し、遅延%s後も復活しない', async (settlement) => {
    const page = fakeScreenSharePage();
    const pendingHealth = deferred<boolean>();
    const beaconUrls: string[] = [];
    let pageHide: (() => void) | undefined, healthStarted = false;
    const calls = { stopped: 0, closed: 0, deleted: 0, republished: 0 };
    const publisher: WhipPublisher = {
      close: () => { calls.closed += 1; },
      deleteResource: async () => { calls.deleted += 1; },
      stop: async () => undefined,
      republish: async () => { calls.republished += 1; return publisher; },
      setPublishToken: () => undefined,
    };
    const videoTrack = { addEventListener: () => undefined, stop: () => { calls.stopped += 1; } };
    const media = { getTracks: () => [videoTrack], getVideoTracks: () => [videoTrack], getAudioTracks: () => [] } as unknown as MediaStream;
    const dependencies: ScreenShareDependencies = {
      requestJson: (async () => createResponse()) as unknown as ScreenShareDependencies['requestJson'],
      startWhipPublisher: async () => publisher,
      waitForStreamReady: () => { healthStarted = true; return pendingHealth.promise; },
      getDisplayMedia: async () => media,
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
      sendBeacon: (url) => { beaconUrls.push(url); return true; },
      onPageHide: (handler) => { pageHide = handler; },
    };
    new ScreenShareController(page.root, dependencies).mount();
    page.button('[data-screen-start]').click();
    await waitFor(() => healthStarted);
    pageHide?.();
    expect(beaconUrls).toEqual(['/api/streams/Ab12Cd34Ef56/stop/']);
    expect(calls).toEqual({ stopped: 1, closed: 1, deleted: 1, republished: 0 });
    if (settlement === 'resolve') pendingHealth.resolve(true); else pendingHealth.reject(new Error('late failure'));
    await flushMicrotasks();
    expect(calls).toEqual({ stopped: 1, closed: 1, deleted: 1, republished: 0 });
    expect(page.step('idle').hidden).toBe(false);
    expect(page.step('live').hidden).toBe(true);
    expect(page.step('error').hidden).toBe(true);
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
      stop: async () => undefined,
      republish: async () => { throw new Error('not used'); },
      setPublishToken: () => undefined,
    };
    const track = { addEventListener: () => undefined, stop: () => { stopped += 1; } };
    const media = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream;
    const dependencies: ScreenShareDependencies = {
      requestJson: ((path: string) => {
        calls.push(path);
        if (path === '/api/streams/') return Promise.resolve(createResponse());
        if (path.endsWith('/extend/')) return delayedExtend.promise;
        return Promise.resolve(null);
      }) as unknown as ScreenShareDependencies['requestJson'],
      startWhipPublisher: async () => publisher,
      waitForStreamReady: async () => true,
      getDisplayMedia: async () => media,
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
      sendBeacon: () => true,
      onPageHide: () => undefined,
    };
    const controller = new ScreenShareController(page.root, dependencies);
    controller.mount();
    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('live').hidden);
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
    const media = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream;
    const dependencies: ScreenShareDependencies = {
      requestJson: (async () => {
        createRequests += 1;
        return createResponse();
      }) as unknown as ScreenShareDependencies['requestJson'],
      startWhipPublisher: async () => {
        publisherStarts += 1;
        throw new Error('publisher should not start');
      },
      waitForStreamReady: async () => true,
      getDisplayMedia: () => pendingMedia.promise,
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
      sendBeacon: () => true,
      onPageHide: (handler) => { pageHide = handler; },
    };
    new ScreenShareController(page.root, dependencies).mount();

    page.button('[data-screen-start]').click();
    pageHide?.();
    pendingMedia.resolve(media);
    await flushMicrotasks();

    expect(stopped).toBe(1);
    expect(createRequests).toBe(0);
    expect(publisherStarts).toBe(0);
  });

  test('開始healthが二度失敗したら画面を保持し、再接続だけでURL表示へ進む', async () => {
    const page = fakeScreenSharePage();
    let healthChecks = 0;
    let mediaSelections = 0;
    let stopped = 0;
    const third = publisherStub();
    const second = publisherStub(async () => third);
    const first = publisherStub(async () => second);
    const track = { addEventListener: () => undefined, stop: () => { stopped += 1; } };
    const media = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
    } as unknown as MediaStream;
    const dependencies: ScreenShareDependencies = {
      requestJson: (async (path: string) => (
        path === '/api/streams/' ? createResponse() : null
      )) as unknown as ScreenShareDependencies['requestJson'],
      startWhipPublisher: async () => first,
      waitForStreamReady: async () => {
        healthChecks += 1;
        return healthChecks === 3;
      },
      getDisplayMedia: async () => {
        mediaSelections += 1;
        return media;
      },
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
      sendBeacon: () => true,
      onPageHide: () => undefined,
    };
    new ScreenShareController(page.root, dependencies).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    expect(page.button('[data-screen-retry]').textContent).toBe('reconnect');
    expect(stopped).toBe(0);

    page.button('[data-screen-retry]').click();
    await waitFor(() => !page.step('live').hidden);
    expect(mediaSelections).toBe(1);
    expect(healthChecks).toBe(3);
    expect(page.url.value).toBe('rtspt://webscreen.tv/live/Ab12Cd34Ef56');
  });

  test('再接続中にpagehideしたら新publisherだけを解放し、error表示へ戻さない', async () => {
    const page = fakeScreenSharePage();
    const pendingPublisher = deferred<WhipPublisher>();
    let pageHide: (() => void) | undefined;
    const counters = { mediaStops: 0, activeClosed: 0, activeDeleted: 0, replacementClosed: 0, replacementDeleted: 0 };
    const replacement = Object.assign(publisherStub(), { close: () => { counters.replacementClosed += 1; }, deleteResource: async () => { counters.replacementDeleted += 1; } });
    const active = Object.assign(publisherStub(() => pendingPublisher.promise), {
      close: () => { counters.activeClosed += 1; }, deleteResource: async () => { counters.activeDeleted += 1; },
    });
    const initial = publisherStub(async () => active);
    const track = { addEventListener: () => undefined, stop: () => { counters.mediaStops += 1; } };
    const media = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream;
    const dependencies: ScreenShareDependencies = {
      requestJson: (async (path: string) => (
        path === '/api/streams/' ? createResponse() : null
      )) as unknown as ScreenShareDependencies['requestJson'],
      startWhipPublisher: async () => initial,
      waitForStreamReady: async () => false,
      getDisplayMedia: async () => media,
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
      sendBeacon: () => true,
      onPageHide: (handler) => { pageHide = handler; },
    };
    new ScreenShareController(page.root, dependencies).mount();
    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    page.button('[data-screen-retry]').click();
    await flushMicrotasks();
    pageHide?.();
    pendingPublisher.resolve(replacement);
    await waitFor(() => counters.replacementDeleted === 1);
    expect(page.step('idle').hidden).toBe(false);
    expect(page.step('error').hidden).toBe(true);
    expect(counters).toMatchObject({ activeClosed: 1, activeDeleted: 1, replacementClosed: 1, replacementDeleted: 1, mediaStops: 1 });
  });

  test('health待機中に停止してもURL/error表示を復活させない', async () => {
    const page = fakeScreenSharePage();
    const pendingHealth = deferred<boolean>();
    let healthChecks = 0;
    const counters = { mediaStops: 0, replacementClosed: 0, replacementDeleted: 0 };
    const replacement = Object.assign(publisherStub(), { close: () => { counters.replacementClosed += 1; }, deleteResource: async () => { counters.replacementDeleted += 1; } });
    const active = publisherStub(async () => replacement);
    const initial = publisherStub(async () => active);
    const track = { addEventListener: () => undefined, stop: () => { counters.mediaStops += 1; } };
    const media = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream;
    new ScreenShareController(page.root, {
      requestJson: (async (path: string) => (
        path === '/api/streams/' ? createResponse() : null
      )) as unknown as ScreenShareDependencies['requestJson'],
      startWhipPublisher: async () => initial,
      waitForStreamReady: async () => {
        healthChecks += 1;
        return healthChecks === 3 ? pendingHealth.promise : false;
      },
      getDisplayMedia: async () => media,
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
      sendBeacon: () => true,
      onPageHide: () => undefined,
    }).mount();
    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    page.button('[data-screen-retry]').click();
    await waitFor(() => healthChecks === 3);
    page.button('[data-screen-stop]').click();
    pendingHealth.resolve(false);
    await flushMicrotasks();
    expect(page.step('idle').hidden).toBe(false);
    expect(page.step('error').hidden).toBe(true);
    expect(counters).toMatchObject({ replacementClosed: 1, replacementDeleted: 1, mediaStops: 1 });
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
    '[data-screen-start]', '[data-screen-copy]',
    '[data-screen-extend]', '[data-screen-stop]', '[data-screen-retry]', '[data-screen-url]',
    '[data-screen-preview]', '[data-screen-elapsed]', '[data-screen-expires]',
    '[data-screen-expiry-warning]', '[data-screen-error-message]', '[data-screen-audio-status]',
    '[data-screen-audio-chip]', '[data-screen-audio-icon]', '[data-screen-audio-label]',
  ]) elements.set(selector, new FakeElement());
  const steps = ['idle', 'login', 'live', 'error'].map((phase) => {
    const step = new FakeElement();
    step.dataset.screenStep = phase;
    return step;
  });
  const root = {
    dataset: {
      labelStart: 'start', labelSelecting: 'selecting', labelCopy: 'copy', labelCopied: 'copied',
      labelExtend: 'extend', labelExtending: 'extending', labelStop: 'stop', labelStopping: 'stopping',
      labelRetry: 'retry', labelReconnect: 'reconnect', labelReconnecting: 'reconnecting',
      audioOn: 'audio-on', audioOff: 'audio-off',
      msgGeneric: 'error', msgH264: 'h264', msgWhip: 'whip', msgDisplayDenied: 'denied',
      msgStreamAlreadyLive: 'already-live', msgStreamCapacity: 'capacity', msgRateLimited: 'rate-limited',
      msgStreamEnded: 'ended', msgStreamUnhealthy: 'unhealthy',
      msgAudioIncluded: 'audio-included', msgVideoOnly: 'video-only',
    },
    querySelector: (selector: string) => elements.get(selector) ?? null,
    querySelectorAll: (selector: string) => {
      if (selector === '[data-screen-step]') return steps;
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
  className = '';
  /** 実 DOM の「アイコン + <span>ラベル</span>」構造を模す。あれば querySelector('span') が返す */
  labelSpan: FakeElement | null = null;
  private readonly listeners: Array<() => void> = [];

  querySelector(selector: string): FakeElement | null {
    if (selector === 'span') return this.labelSpan;
    return null;
  }

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

function publisherStub(republish: () => Promise<WhipPublisher> = async () => {
  throw new Error('not used');
}): WhipPublisher {
  return {
    close: () => undefined,
    deleteResource: async () => undefined,
    stop: async () => undefined,
    republish,
    setPublishToken: () => undefined,
  };
}
