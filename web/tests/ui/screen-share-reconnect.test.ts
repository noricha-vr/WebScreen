import { describe, expect, test } from 'bun:test';

import { ScreenShareController, type ScreenShareDependencies } from '../../src/lib/ui/screen-share';
import type { WhipPublisher } from '../../src/lib/ui/whip-publisher';

describe('画面共有の再接続', () => {
  test('初回healthが二度失敗しても画面を保持し、再接続だけでURL表示へ進む', async () => {
    const page = fakePage();
    let healthChecks = 0;
    let selections = 0;
    let stopped = 0;
    const third = publisher();
    const second = publisher(async () => third);
    const first = publisher(async () => second);
    const capture = media(() => { stopped += 1; });
    new ScreenShareController(page.root, dependencies({
      startWhipPublisher: async () => first,
      waitForStreamReady: async () => ++healthChecks === 3,
      getDisplayMedia: async () => { selections += 1; return capture; },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    expect(page.button('[data-screen-retry]').textContent).toBe('reconnect');
    expect(stopped).toBe(0);

    page.button('[data-screen-retry]').click();
    await waitFor(() => !page.step('url').hidden);
    expect(selections).toBe(1);
    expect(healthChecks).toBe(3);
    expect(page.url.value).toBe('rtspt://webscreen.tv/live/Ab12Cd34Ef56');
  });

  test('再接続中のpagehideはlate publisherも解放し、error表示へ戻さない', async () => {
    const page = fakePage();
    const pending = deferred<WhipPublisher>();
    let pageHide: (() => void) | undefined;
    const count = { media: 0, activeClose: 0, activeDelete: 0, lateClose: 0, lateDelete: 0 };
    const late = Object.assign(publisher(), {
      close: () => { count.lateClose += 1; },
      deleteResource: async () => { count.lateDelete += 1; },
    });
    const active = Object.assign(publisher(() => pending.promise), {
      close: () => { count.activeClose += 1; },
      deleteResource: async () => { count.activeDelete += 1; },
    });
    new ScreenShareController(page.root, dependencies({
      startWhipPublisher: async () => publisher(async () => active),
      waitForStreamReady: async () => false,
      getDisplayMedia: async () => media(() => { count.media += 1; }),
      onPageHide: (handler) => { pageHide = handler; },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    page.button('[data-screen-retry]').click();
    await flushMicrotasks();
    pageHide?.();
    pending.resolve(late);
    await waitFor(() => count.lateDelete === 1);

    expect(page.step('idle').hidden).toBe(false);
    expect(page.step('error').hidden).toBe(true);
    expect(count).toEqual({ media: 1, activeClose: 1, activeDelete: 1, lateClose: 1, lateDelete: 1 });
  });

  test('再接続health待機中の停止後にURL/error表示を復活させない', async () => {
    const page = fakePage();
    const pendingHealth = deferred<boolean>();
    let healthChecks = 0;
    const count = { media: 0, lateClose: 0, lateDelete: 0 };
    const late = Object.assign(publisher(), {
      close: () => { count.lateClose += 1; },
      deleteResource: async () => { count.lateDelete += 1; },
    });
    const active = publisher(async () => late);
    new ScreenShareController(page.root, dependencies({
      startWhipPublisher: async () => publisher(async () => active),
      waitForStreamReady: async () => ++healthChecks === 3 ? pendingHealth.promise : false,
      getDisplayMedia: async () => media(() => { count.media += 1; }),
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    page.button('[data-screen-retry]').click();
    await waitFor(() => healthChecks === 3);
    page.button('[data-screen-stop]').click();
    pendingHealth.resolve(false);
    await flushMicrotasks();

    expect(page.step('idle').hidden).toBe(false);
    expect(page.step('error').hidden).toBe(true);
    expect(count).toEqual({ media: 1, lateClose: 1, lateDelete: 1 });
  });
});

function dependencies(overrides: Partial<ScreenShareDependencies>): ScreenShareDependencies {
  return {
    requestJson: (async (path: string) => path === '/api/streams/' ? createResponse() : null) as
      unknown as ScreenShareDependencies['requestJson'],
    startWhipPublisher: async () => publisher(),
    waitForStreamReady: async () => true,
    getDisplayMedia: async () => media(),
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

function media(onStop = () => {}): MediaStream {
  const track = { addEventListener: () => undefined, stop: onStop };
  return { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] } as
    unknown as MediaStream;
}

function publisher(republish: () => Promise<WhipPublisher> = async () => {
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

function fakePage(): { root: HTMLElement; button: (selector: string) => FakeElement; step: (phase: string) => FakeElement; url: FakeElement } {
  const elements = new Map<string, FakeElement>();
  for (const selector of [
    '[data-screen-start]', '[data-screen-copy]', '[data-screen-show-live]', '[data-screen-extend]',
    '[data-screen-stop]', '[data-screen-retry]', '[data-screen-url]', '[data-screen-preview]',
    '[data-screen-expiry-warning]', '[data-screen-error-message]', '[data-screen-indicators]',
    '[data-screen-audio-status]', '[data-screen-stop-others]',
  ]) elements.set(selector, new FakeElement());
  const steps = ['idle', 'login', 'url', 'live', 'error'].map((phase) => {
    const step = new FakeElement(); step.dataset.screenStep = phase; return step;
  });
  const root = {
    dataset: {
      labelStart: 'start', labelSelecting: 'selecting', labelRetry: 'retry',
      labelReconnect: 'reconnect', labelReconnecting: 'reconnecting', labelStopOthers: 'stop-others',
      msgGeneric: 'error', msgStreamUnhealthy: 'unhealthy', msgVideoOnly: 'video',
    },
    querySelector: (selector: string) => elements.get(selector) ?? null,
    querySelectorAll: (selector: string) => selector === '[data-screen-step]' ? steps : [],
  } as unknown as HTMLElement;
  return { root, button: (selector) => elements.get(selector)!, step: (phase) => steps.find((step) => step.dataset.screenStep === phase)!, url: elements.get('[data-screen-url]')! };
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
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
