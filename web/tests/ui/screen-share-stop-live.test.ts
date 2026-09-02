import { describe, expect, test } from 'bun:test';

import { ERROR_CODES } from '../../src/lib/contracts/api';
import { ScreenShareController, type ScreenShareDependencies } from '../../src/lib/ui/screen-share';
import { JsonRequestError } from '../../src/lib/ui/request-json';
import type { WhipPublisher } from '../../src/lib/ui/whip-publisher';

describe('他の配信を終了して開始', () => {
  test('STREAM_ALREADY_LIVE の時だけ終了ボタンを表示する', async () => {
    const liveError = await pageAfterStartError(
      new JsonRequestError(409, ERROR_CODES.streamAlreadyLive)
    );
    const otherError = await pageAfterStartError(new JsonRequestError(429, ERROR_CODES.streamCreateRateLimited));

    expect(liveError.button('[data-screen-stop-others]').hidden).toBe(false);
    expect(otherError.button('[data-screen-stop-others]').hidden).toBe(true);
  });

  test('画面選択後に停止、待機、配信開始の順で URL 表示まで進む', async () => {
    const page = fakePage();
    const events: string[] = [];
    let creates = 0;
    const controller = new ScreenShareController(page.root, dependencies({
      requestJson: async (path) => {
        if (path === '/api/streams/') {
          creates += 1;
          if (creates === 1) throw new JsonRequestError(409, ERROR_CODES.streamAlreadyLive);
          events.push('create');
          return createResponse();
        }
        events.push('stop-live');
        return { stopped: 1, retryAfterSeconds: 0 };
      },
      getDisplayMedia: async () => {
        events.push('media');
        return media();
      },
      delay: async (ms) => { events.push(`delay:${ms}`); },
    }));
    controller.mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    events.length = 0;
    page.button('[data-screen-stop-others]').click();
    await waitFor(() => !page.step('url').hidden);

    expect(events).toEqual(['media', 'stop-live', 'delay:3000', 'create']);
  });

  test('待機中にページ離脱すると取得済み画面を止め、新しい配信を作らない', async () => {
    const page = fakePage();
    let creates = 0;
    let pageHide: (() => void) | undefined;
    const stopCounts = [0, 0];
    let selections = 0;
    let resolveDelay: (() => void) | undefined;
    const controller = new ScreenShareController(page.root, dependencies({
      requestJson: async (path) => {
        if (path === '/api/streams/') {
          creates += 1;
          if (creates === 1) throw new JsonRequestError(409, ERROR_CODES.streamAlreadyLive);
          return createResponse();
        }
        return { stopped: 1, retryAfterSeconds: 0 };
      },
      getDisplayMedia: async () => {
        const selection = selections;
        selections += 1;
        return media(() => { stopCounts[selection] = (stopCounts[selection] ?? 0) + 1; });
      },
      delay: () => new Promise<void>((resolve) => { resolveDelay = resolve; }),
      onPageHide: (handler) => { pageHide = handler; },
    }));
    controller.mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    page.button('[data-screen-stop-others]').click();
    await waitFor(() => resolveDelay !== undefined);
    expect(page.button('[data-screen-retry]').disabled).toBe(true);
    expect(page.button('[data-screen-stop-others]').disabled).toBe(true);
    expect(page.button('[data-screen-stop-others]').textContent).toBe('stopping');
    expect(page.button('[data-screen-error-message]').textContent).toBe('stopping');
    pageHide?.();
    resolveDelay?.();
    await flushMicrotasks();

    expect(creates).toBe(1);
    expect(stopCounts).toEqual([1, 1]);
    expect(page.button('[data-screen-retry]').disabled).toBe(false);
  });

  test('stop-live待機中の2回目startを拒否して既存runを維持する', async () => {
    const page = fakePage();
    const pendingStopLive = deferred<Record<string, unknown>>();
    const stopCounts = [0, 0];
    let selections = 0;
    let creates = 0;
    let oldSignal: AbortSignal | undefined;
    let pageHide: (() => void) | undefined;
    new ScreenShareController(page.root, dependencies({
      requestJson: async (path, init) => {
        if (path === '/api/streams/stop-live/') {
          oldSignal = init.signal as AbortSignal | undefined;
          return pendingStopLive.promise;
        }
        if (path === '/api/streams/') {
          creates += 1;
          if (creates === 1) throw new JsonRequestError(409, ERROR_CODES.streamAlreadyLive);
          return createResponse();
        }
        return null;
      },
      getDisplayMedia: async () => {
        const selection = selections;
        selections += 1;
        return media(() => { stopCounts[selection] = (stopCounts[selection] ?? 0) + 1; });
      },
      onPageHide: (handler) => { pageHide = handler; },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    page.button('[data-screen-stop-others]').click();
    await waitFor(() => oldSignal !== undefined);
    page.button('[data-screen-start]').click();
    await flushMicrotasks();

    expect(oldSignal?.aborted).toBe(false);
    expect(selections).toBe(2);
    expect(creates).toBe(1);
    expect(stopCounts).toEqual([1, 0]);
    pageHide?.();
    expect(oldSignal?.aborted).toBe(true);
    expect(stopCounts).toEqual([1, 1]);
    pendingStopLive.resolve({ stopped: 1, retryAfterSeconds: 0 });
    await flushMicrotasks();

    expect(creates).toBe(1);
    expect(stopCounts).toEqual([1, 1]);
    expect(page.step('idle').hidden).toBe(false);
    expect(page.step('error').hidden).toBe(true);
  });

  test('stop-live後のcreate失敗でも再取得したtrackを一度だけ停止する', async () => {
    const page = fakePage();
    const stopCounts = [0, 0];
    let creates = 0;
    let selections = 0;
    new ScreenShareController(page.root, dependencies({
      requestJson: async (path) => {
        if (path === '/api/streams/stop-live/') return { stopped: 1, retryAfterSeconds: 0 };
        if (path !== '/api/streams/') return null;
        creates += 1;
        if (creates === 1) throw new JsonRequestError(409, ERROR_CODES.streamAlreadyLive);
        throw new Error('create failed');
      },
      getDisplayMedia: async () => {
        const selection = selections;
        selections += 1;
        return media(() => { stopCounts[selection] = (stopCounts[selection] ?? 0) + 1; });
      },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    page.button('[data-screen-stop-others]').click();
    await waitFor(() => stopCounts[1] === 1);

    expect(stopCounts).toEqual([1, 1]);
  });

  test('stop-live後のpublisher失敗でも再取得したtrackを一度だけ停止する', async () => {
    const page = fakePage();
    const stopCounts = [0, 0];
    let creates = 0;
    let selections = 0;
    new ScreenShareController(page.root, dependencies({
      requestJson: async (path) => {
        if (path === '/api/streams/stop-live/') return { stopped: 1, retryAfterSeconds: 0 };
        if (path !== '/api/streams/') return null;
        creates += 1;
        if (creates === 1) throw new JsonRequestError(409, ERROR_CODES.streamAlreadyLive);
        return createResponse();
      },
      startWhipPublisher: async () => { throw new Error('publish failed'); },
      getDisplayMedia: async () => {
        const selection = selections;
        selections += 1;
        return media(() => { stopCounts[selection] = (stopCounts[selection] ?? 0) + 1; });
      },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    page.button('[data-screen-stop-others]').click();
    await waitFor(() => stopCounts[1] === 1);

    expect(stopCounts).toEqual([1, 1]);
  });

  test('create待機中のpagehide後に応答してもURLやerrorを表示しない', async () => {
    const page = fakePage();
    const pendingCreate = deferred<Record<string, unknown>>();
    let pageHide: (() => void) | undefined;
    let stopCount = 0;
    let publisherStarts = 0;
    new ScreenShareController(page.root, dependencies({
      requestJson: async (path) => path === '/api/streams/' ? pendingCreate.promise : null,
      startWhipPublisher: async () => {
        publisherStarts += 1;
        return publisher();
      },
      getDisplayMedia: async () => media(() => { stopCount += 1; }),
      onPageHide: (handler) => { pageHide = handler; },
    })).mount();

    page.button('[data-screen-start]').click();
    await flushMicrotasks();
    pageHide?.();
    pendingCreate.resolve(createResponse());
    await flushMicrotasks();

    expect(stopCount).toBe(1);
    expect(publisherStarts).toBe(0);
    expect(page.step('idle').hidden).toBe(false);
    expect(page.step('url').hidden).toBe(true);
    expect(page.step('error').hidden).toBe(true);
  });

  test('publisher待機中のpagehide後に解決しても全資源を一度だけ解放する', async () => {
    const page = fakePage();
    const pendingPublisher = deferred<WhipPublisher>();
    let pageHide: (() => void) | undefined;
    let publisherStarted = false;
    const calls = { stopped: 0, closed: 0, deleted: 0, serverStops: 0, healthChecks: 0 };
    const delayedPublisher: WhipPublisher = {
      close: () => { calls.closed += 1; },
      deleteResource: async () => { calls.deleted += 1; },
      stop: async () => undefined,
      republish: async () => delayedPublisher,
      setPublishToken: () => undefined,
    };
    new ScreenShareController(page.root, dependencies({
      requestJson: async (path) => {
        if (path === '/api/streams/') return createResponse();
        if (path.endsWith('/stop/')) calls.serverStops += 1;
        return null;
      },
      startWhipPublisher: () => {
        publisherStarted = true;
        return pendingPublisher.promise;
      },
      waitForStreamReady: async () => {
        calls.healthChecks += 1;
        return true;
      },
      getDisplayMedia: async () => media(() => { calls.stopped += 1; }),
      onPageHide: (handler) => { pageHide = handler; },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => publisherStarted);
    pageHide?.();
    expect(calls.stopped).toBe(1);
    pendingPublisher.resolve(delayedPublisher);
    await waitFor(() => calls.deleted === 1 && calls.serverStops === 1);

    expect(calls).toEqual({ stopped: 1, closed: 1, deleted: 1, serverStops: 1, healthChecks: 0 });
    expect(page.step('idle').hidden).toBe(false);
    expect(page.step('url').hidden).toBe(true);
    expect(page.step('error').hidden).toBe(true);
  });

  test('extend待機中の停止はsession signalをabortして遅延UIを復活させない', async () => {
    const page = fakePage();
    const pendingExtend = deferred<Record<string, unknown>>();
    let extendSignal: AbortSignal | undefined;
    new ScreenShareController(page.root, dependencies({
      requestJson: async (path, init) => {
        if (path === '/api/streams/') return createResponse();
        if (path.endsWith('/extend/')) {
          extendSignal = init.signal as AbortSignal | undefined;
          return pendingExtend.promise;
        }
        return null;
      },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('url').hidden);
    page.button('[data-screen-extend]').click();
    await waitFor(() => extendSignal !== undefined);
    page.button('[data-screen-stop]').click();

    expect(extendSignal?.aborted).toBe(true);
    pendingExtend.resolve({
      extendExpiresAt: '2026-09-01T02:00:00.000Z',
      publishToken: 'late-token',
    });
    await flushMicrotasks();
    expect(page.step('idle').hidden).toBe(false);
    expect(page.step('error').hidden).toBe(true);
  });

  test('stop-live API の失敗時は取得済み画面を停止してエラー表示へ戻る', async () => {
    const page = fakePage();
    let selections = 0;
    let stopLiveTrackStopped = false;
    const controller = new ScreenShareController(page.root, dependencies({
      requestJson: async (path) => {
        if (path === '/api/streams/') {
          throw new JsonRequestError(409, ERROR_CODES.streamAlreadyLive);
        }
        throw new Error('stop-live failed');
      },
      getDisplayMedia: async () => {
        selections += 1;
        return media(() => { if (selections === 2) stopLiveTrackStopped = true; });
      },
    }));
    controller.mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    page.button('[data-screen-stop-others]').click();
    await waitFor(() => stopLiveTrackStopped);

    expect(page.step('error').hidden).toBe(false);
    expect(page.button('[data-screen-stop-others]').hidden).toBe(true);
    expect(page.button('[data-screen-retry]').disabled).toBe(false);
  });
});

async function pageAfterStartError(error: Error): Promise<ReturnType<typeof fakePage>> {
  const page = fakePage();
  new ScreenShareController(page.root, dependencies({
    requestJson: async () => { throw error; },
    getDisplayMedia: async () => media(),
  })).mount();
  page.button('[data-screen-start]').click();
  await waitFor(() => !page.step('error').hidden);
  return page;
}

function dependencies(overrides: Partial<ScreenShareDependencies>): ScreenShareDependencies {
  return {
    requestJson: async () => createResponse(),
    startWhipPublisher: async () => publisher(),
    waitForStreamReady: async () => true,
    getDisplayMedia: async () => media(),
    delay: async () => undefined,
    now: () => Date.parse('2026-09-01T00:00:00.000Z'),
    sendBeacon: () => true,
    onPageHide: () => undefined,
    ...overrides,
  };
}

function createResponse(): Record<string, unknown> {
  return {
    id: 'Ab12Cd34Ef56', streamUrl: 'rtspt://webscreen.tv/live/Ab12Cd34Ef56', status: 'live',
    publishToken: 'token', publishTokenExpiresAt: '2026-09-01T01:00:00.000Z',
    extendExpiresAt: '2026-09-01T01:00:00.000Z', startedAt: '2026-09-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-09-01T00:00:00.000Z', endedAt: null, endReason: null,
  };
}

function media(onStop = () => undefined): MediaStream {
  const track = { addEventListener: () => undefined, stop: onStop };
  return { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream;
}

function publisher(): WhipPublisher {
  return {
    close: () => undefined,
    deleteResource: async () => undefined,
    stop: async () => undefined,
    republish: async () => publisher(),
    setPublishToken: () => undefined,
  };
}

function fakePage(): {
  root: HTMLElement;
  button: (selector: string) => FakeElement;
  step: (phase: string) => FakeElement;
} {
  const elements = new Map<string, FakeElement>();
  for (const selector of [
    '[data-screen-start]', '[data-screen-stop-others]', '[data-screen-retry]',
    '[data-screen-extend]', '[data-screen-stop]',
    '[data-screen-error-message]', '[data-screen-url]', '[data-screen-audio-status]',
    '[data-screen-preview]', '[data-screen-expiry-warning]', '[data-screen-indicators]',
  ]) elements.set(selector, new FakeElement());
  const steps = ['idle', 'login', 'url', 'live', 'error'].map((phase) => {
    const step = new FakeElement();
    step.dataset.screenStep = phase;
    return step;
  });
  const root = {
    dataset: {
      labelStart: 'start', labelSelecting: 'selecting', labelRetry: 'retry', labelReconnect: 'reconnect',
      labelStopOthers: 'stop-others', labelStoppingOthers: 'stopping', msgStreamAlreadyLive: 'already-live',
      msgGeneric: 'error', msgH264: 'h264', msgWhip: 'whip', msgDisplayDenied: 'denied',
      msgStreamCapacity: 'capacity', msgRateLimited: 'rate-limited', msgStreamEnded: 'ended',
      msgStreamUnhealthy: 'unhealthy', msgAudioIncluded: 'audio', msgVideoOnly: 'video',
    },
    querySelector: (selector: string) => elements.get(selector) ?? null,
    querySelectorAll: (selector: string) => selector === '[data-screen-step]' ? steps : [],
  } as unknown as HTMLElement;
  return { root, button: (selector) => elements.get(selector)!, step: (phase) => steps.find((step) => step.dataset.screenStep === phase)! };
}

class FakeElement {
  dataset: Record<string, string> = {};
  disabled = false;
  hidden = false;
  textContent = '';
  value = '';
  srcObject: MediaStream | null = null;
  private readonly listeners: Array<() => void> = [];

  querySelector(): null { return null; }
  addEventListener(event: string, listener: () => void): void { if (event === 'click') this.listeners.push(listener); }
  click(): void { for (const listener of this.listeners) listener(); }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error('Expected asynchronous UI update');
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
