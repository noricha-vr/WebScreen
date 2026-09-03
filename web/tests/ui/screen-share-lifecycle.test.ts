import { describe, expect, test } from 'bun:test';

import { ScreenShareController } from '../../src/lib/ui/screen-share';
import type { ScreenShareDependencies } from '../../src/lib/ui/screen-share';
import type { WhipPublisher } from '../../src/lib/ui/whip-publisher';

describe('画面共有 controller', () => {
  test('フローは常時表示され、開始後は配信ステップを現在地にする', async () => {
    const page = fakeScreenSharePage();
    const track = { addEventListener: () => undefined, stop: () => undefined };
    const media = {
      getTracks: () => [track],
      getVideoTracks: () => [track],
      getAudioTracks: () => [],
    } as unknown as MediaStream;
    new ScreenShareController(page.root, {
      requestJson: (async () => createResponse()) as unknown as ScreenShareDependencies['requestJson'],
      startWhipPublisher: async () => publisherStub(),
      waitForStreamReady: async () => true,
      getDisplayMedia: async () => media,
      previewPreference: { load: () => null, save: () => undefined },
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
      sendBeacon: () => true,
      onPageHide: () => undefined,
    }).mount();

    expect(page.currentFlowItems()).toEqual(['1']);

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('live').hidden);

    expect(page.currentFlowItems()).toEqual(['2']);
  });

  test('ピッカーを閉じると開始前のidleへ戻り、ラベルは span だけ差し替えてアイコンを保つ', async () => {
    const page = fakeScreenSharePage();
    const start = page.button('[data-screen-start]');
    const retry = page.button('[data-screen-retry]');
    start.labelSpan = new FakeElement();
    start.labelSpan.textContent = 'start';
    let rejectPicker: ((reason: unknown) => void) | undefined;
    new ScreenShareController(page.root, {
      requestJson: (async () => createResponse()) as unknown as ScreenShareDependencies['requestJson'],
      startWhipPublisher: async () => publisherStub(),
      waitForStreamReady: async () => true,
      getDisplayMedia: () => new Promise((_resolve, reject) => { rejectPicker = reject; }),
      previewPreference: { load: () => null, save: () => undefined },
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
      sendBeacon: () => true,
      onPageHide: () => undefined,
    }).mount();

    start.click();
    expect(start.disabled).toBe(true);
    expect(retry.disabled).toBe(true);
    expect(start.labelSpan.textContent).toBe('selecting');
    expect(start.textContent).toBe(''); // ボタン直下（アイコン）は書き換えない

    rejectPicker!(new DOMException('denied', 'NotAllowedError'));
    await waitFor(() => !page.step('idle').hidden);
    expect(start.disabled).toBe(false);
    expect(retry.disabled).toBe(false);
    expect(start.labelSpan.textContent).toBe('start');
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
      previewPreference: { load: () => null, save: () => undefined },
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
      previewPreference: { load: () => null, save: () => undefined },
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
  currentFlowItems: () => string[];
} {
  const elements = new Map<string, FakeElement>();
  for (const selector of [
    '[data-screen-start]', '[data-screen-copy]',
    '[data-screen-stop]', '[data-screen-retry]', '[data-screen-url]',
    '[data-screen-preview]', '[data-screen-elapsed]', '[data-screen-expires]',
    '[data-screen-expiry-warning]', '[data-screen-error-message]',
    '[data-screen-audio-status]',
  ]) elements.set(selector, new FakeElement());
  const steps = ['idle', 'login', 'starting', 'live', 'error'].map((phase) => {
    const step = new FakeElement();
    step.dataset.screenStep = phase;
    return step;
  });
  const flowItems = ['1', '2', '3'].map((position) => {
    const item = new FakeElement();
    item.dataset.screenFlowItem = position;
    return item;
  });
  const root = {
    dataset: {
      labelStart: 'start', labelSelecting: 'selecting', labelCopy: 'copy', labelCopied: 'copied',
      labelStop: 'stop', labelStopping: 'stopping',
      labelRetry: 'retry', labelReconnect: 'reconnect', labelReconnecting: 'reconnecting',
      msgGeneric: 'error', msgH264: 'h264', msgWhip: 'whip', msgDisplayDenied: 'denied',
      msgStreamAlreadyLive: 'already-live', msgStreamCapacity: 'capacity', msgRateLimited: 'rate-limited',
      msgStreamEnded: 'ended', msgStreamUnhealthy: 'unhealthy',
      msgAudioIncluded: 'audio-included', msgVideoOnly: 'video-only',
    },
    querySelector: (selector: string) => elements.get(selector) ?? null,
    querySelectorAll: (selector: string) => {
      if (selector === '[data-screen-step]') return steps;
      if (selector === '[data-screen-flow-item]') return flowItems;
      return [];
    },
  } as unknown as HTMLElement;
  return {
    root,
    button: (selector) => elements.get(selector)!,
    step: (phase) => steps.find((step) => step.dataset.screenStep === phase)!,
    url: elements.get('[data-screen-url]')!,
    currentFlowItems: () => flowItems.filter((item) => item.dataset.state === 'current')
      .map((item) => item.dataset.screenFlowItem!),
  };
}

class FakeElement {
  dataset: Record<string, string> = {};
  disabled = false;
  hidden = false;
  paused = false;
  pause(): void { this.paused = true; }
  play(): Promise<void> { this.paused = false; return Promise.resolve(); }
  srcObject: MediaProvider | null = null;
  textContent = '';
  value = '';
  /** 実 DOM の「アイコン + <span>ラベル</span>」構造を模す。あれば querySelector('span') が返す */
  labelSpan: FakeElement | null = null;
  private readonly listeners: Array<() => void> = [];

  querySelector(selector: string): FakeElement | null {
    return selector === 'span' ? this.labelSpan : null;
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
  for (let attempt = 0; attempt < 30; attempt += 1) {
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
