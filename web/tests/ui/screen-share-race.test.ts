import { describe, expect, test } from 'bun:test';

import { ScreenShareController, type ScreenShareDependencies } from '../../src/lib/ui/screen-share';
import type { WhipPublisher } from '../../src/lib/ui/whip-publisher';

const START_TOKEN = '11111111-1111-4111-8111-111111111111';

describe('画面共有runの競合拒否', () => {
  test('pagehideはcreate headerと同じtokenをcancel-start beaconへ送る', async () => {
    const page = fakePage();
    const pendingCreate = deferred<Record<string, unknown>>();
    let pageHide: (() => void) | undefined;
    let createToken: string | undefined;
    let beaconUrl: string | undefined;
    let beaconData: BodyInit | null | undefined;
    new ScreenShareController(page.root, dependencies({
      createStartToken: () => START_TOKEN,
      requestJson: async (path, init) => {
        if (path === '/api/streams/') {
          createToken = new Headers(init.headers).get('X-WebScreen-Start-Token') ?? undefined;
          return pendingCreate.promise;
        }
        return null;
      },
      sendBeacon: (url, data) => {
        beaconUrl = url;
        beaconData = data;
        return true;
      },
      onPageHide: (handler) => { pageHide = handler; },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => createToken !== undefined);
    pageHide?.();

    expect(createToken).toBe(START_TOKEN);
    expect(beaconUrl).toBe('/api/streams/cancel-start/');
    expect(beaconData).toBeInstanceOf(Blob);
    expect(JSON.parse(await (beaconData as Blob).text())).toEqual({ startToken: START_TOKEN });
    expect((beaconData as Blob).type).toContain('application/json');
    pendingCreate.resolve(createResponse());
    await flushMicrotasks();
  });

  test.each(['false', 'throw'] as const)(
    'cancel-start beaconが%sならkeepalive fetchへfallbackする',
    async (failure) => {
      const page = fakePage();
      const pendingCreate = deferred<Record<string, unknown>>();
      let pageHide: (() => void) | undefined;
      let fallback: RequestInit | undefined;
      const originalWarn = console.warn;
      console.warn = () => undefined;
      try {
        new ScreenShareController(page.root, dependencies({
          createStartToken: () => START_TOKEN,
          requestJson: async (path, init) => {
            if (path === '/api/streams/') return pendingCreate.promise;
            if (path === '/api/streams/cancel-start/') fallback = init;
            return null;
          },
          sendBeacon: () => {
            if (failure === 'throw') throw new Error('beacon unavailable');
            return false;
          },
          onPageHide: (handler) => { pageHide = handler; },
        })).mount();

        page.button('[data-screen-start]').click();
        await flushMicrotasks();
        pageHide?.();
        await waitFor(() => fallback !== undefined);

        expect(fallback).toMatchObject({ method: 'POST', keepalive: true });
        expect(new Headers(fallback?.headers).get('Content-Type')).toBe('application/json');
        expect(JSON.parse(String(fallback?.body))).toEqual({ startToken: START_TOKEN });
        pendingCreate.resolve(createResponse());
        await flushMicrotasks();
      } finally {
        console.warn = originalWarn;
      }
    }
  );

  test('live IDが既知ならpagehideは既存stopだけをbeaconしcancel-startを送らない', async () => {
    const page = fakePage();
    let pageHide: (() => void) | undefined;
    const beaconUrls: string[] = [];
    const requestUrls: string[] = [];
    new ScreenShareController(page.root, dependencies({
      createStartToken: () => START_TOKEN,
      requestJson: async (path) => {
        requestUrls.push(path);
        return path === '/api/streams/' ? createResponse() : null;
      },
      sendBeacon: (url) => {
        beaconUrls.push(url);
        return true;
      },
      onPageHide: (handler) => { pageHide = handler; },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('live').hidden);
    pageHide?.();
    await flushMicrotasks();

    expect(beaconUrls).toEqual(['/api/streams/OldStream123/stop/']);
    expect(requestUrls).not.toContain('/api/streams/cancel-start/');
  });

  test('create待機中のpagehideでPOSTをabortせず、回収したIDを即stopする', async () => {
    const page = fakePage();
    const pendingCreate = deferred<Record<string, unknown>>();
    let pageHide: (() => void) | undefined;
    let createRequested = false;
    let createSignal: AbortSignal | undefined;
    const calls = { trackStops: 0, publisherStarts: 0, serverStops: 0 };
    new ScreenShareController(page.root, dependencies({
      requestJson: async (path, init) => {
        if (path === '/api/streams/') {
          createRequested = true;
          createSignal = init.signal as AbortSignal | undefined;
          createSignal?.addEventListener(
            'abort',
            () => pendingCreate.reject(new DOMException('aborted', 'AbortError')),
            { once: true }
          );
          return pendingCreate.promise;
        }
        if (path.endsWith('/stop/')) calls.serverStops += 1;
        return null;
      },
      startWhipPublisher: async () => {
        calls.publisherStarts += 1;
        return publisher(() => undefined, () => undefined);
      },
      getDisplayMedia: async () => media(() => { calls.trackStops += 1; }),
      onPageHide: (handler) => { pageHide = handler; },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => createRequested);
    pageHide?.();
    pendingCreate.resolve(createResponse());
    await waitFor(() => calls.serverStops === 1);

    expect(createSignal).toBeUndefined();
    expect(calls).toEqual({ trackStops: 1, publisherStarts: 0, serverStops: 1 });
    expect(page.step('idle').hidden).toBe(false);
    expect(page.step('live').hidden).toBe(true);
    expect(page.step('error').hidden).toBe(true);
  });

  test('picker未解決中はstartとstop-othersの重複入口を拒否する', async () => {
    const page = fakePage();
    const pendingMedia = deferred<MediaStream>();
    const calls = { mediaSelections: 0, creates: 0, publisherStarts: 0 };
    new ScreenShareController(page.root, dependencies({
      requestJson: async (path) => {
        if (path === '/api/streams/') {
          calls.creates += 1;
          return createResponse();
        }
        return null;
      },
      getDisplayMedia: () => {
        calls.mediaSelections += 1;
        return pendingMedia.promise;
      },
      startWhipPublisher: async () => {
        calls.publisherStarts += 1;
        return publisher(() => undefined, () => undefined);
      },
    })).mount();

    page.button('[data-screen-start]').click();
    page.button('[data-screen-start]').click();
    page.button('[data-screen-stop-others]').click();
    await flushMicrotasks();

    expect(calls).toEqual({ mediaSelections: 1, creates: 0, publisherStarts: 0 });
    pendingMedia.resolve(media(() => undefined));
    await waitFor(() => !page.step('live').hidden);
    expect(calls).toEqual({ mediaSelections: 1, creates: 1, publisherStarts: 1 });
  });

  test('picker cancel後は予約を解除して再開始できる', async () => {
    const page = fakePage();
    let selections = 0;
    let creates = 0;
    new ScreenShareController(page.root, dependencies({
      requestJson: async (path) => {
        if (path === '/api/streams/') creates += 1;
        return createResponse();
      },
      getDisplayMedia: async () => {
        selections += 1;
        if (selections === 1) throw new DOMException('denied', 'NotAllowedError');
        return media(() => undefined);
      },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('live').hidden);

    expect(selections).toBe(2);
    expect(creates).toBe(1);
  });

  test.each(['resolve', 'reject'] as const)(
    'health待機中の2回目startを拒否し、pagehide後の%sでも二重解放しない',
    async (settlement) => {
      const page = fakePage();
      const oldHealth = deferred<boolean>();
      let pageHide: (() => void) | undefined;
      const calls = {
        mediaSelections: 0,
        creates: 0,
        publisherStarts: 0,
        healthChecks: 0,
        trackStops: 0,
        closes: 0,
        deletes: 0,
        serverStops: 0,
      };
      const activePublisher = publisher(
        () => { calls.closes += 1; },
        () => { calls.deletes += 1; }
      );
      new ScreenShareController(page.root, dependencies({
        requestJson: async (path) => {
          if (path === '/api/streams/') {
            calls.creates += 1;
            return createResponse();
          }
          return null;
        },
        getDisplayMedia: async () => {
          calls.mediaSelections += 1;
          return media(() => { calls.trackStops += 1; });
        },
        startWhipPublisher: async () => {
          calls.publisherStarts += 1;
          return activePublisher;
        },
        waitForStreamReady: async () => {
          calls.healthChecks += 1;
          return oldHealth.promise;
        },
        sendBeacon: () => {
          calls.serverStops += 1;
          return true;
        },
        onPageHide: (handler) => { pageHide = handler; },
      })).mount();

      page.button('[data-screen-start]').click();
      await waitFor(() => calls.healthChecks === 1);
      page.button('[data-screen-start]').click();
      await flushMicrotasks();

      expect(calls).toEqual({
        mediaSelections: 1,
        creates: 1,
        publisherStarts: 1,
        healthChecks: 1,
        trackStops: 0,
        closes: 0,
        deletes: 0,
        serverStops: 0,
      });
      pageHide?.();
      const released = {
        mediaSelections: 1,
        creates: 1,
        publisherStarts: 1,
        healthChecks: 1,
        trackStops: 1,
        closes: 1,
        deletes: 1,
        serverStops: 1,
      };
      expect(calls).toEqual(released);

      if (settlement === 'resolve') oldHealth.resolve(true);
      else oldHealth.reject(new Error('late health failure'));
      await flushMicrotasks();

      expect(calls).toEqual(released);
      expect(page.step('idle').hidden).toBe(false);
      expect(page.step('live').hidden).toBe(true);
      expect(page.step('error').hidden).toBe(true);
    }
  );
});

function dependencies(overrides: Partial<ScreenShareDependencies>): ScreenShareDependencies {
  return {
    requestJson: async () => null,
    startWhipPublisher: async () => publisher(() => undefined, () => undefined),
    waitForStreamReady: async () => true,
    getDisplayMedia: async () => media(() => undefined),
    delay: async () => undefined,
    now: () => Date.parse('2026-09-01T00:00:00.000Z'),
    sendBeacon: () => true,
    onPageHide: () => undefined,
    ...overrides,
  };
}

function createResponse(): Record<string, unknown> {
  return {
    id: 'OldStream123',
    streamUrl: 'rtspt://webscreen.tv/live/OldStream123',
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

function media(onStop: () => void): MediaStream {
  const track = { addEventListener: () => undefined, stop: onStop };
  return {
    getTracks: () => [track],
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
  } as unknown as MediaStream;
}

function publisher(onClose: () => void, onDelete: () => void): WhipPublisher {
  const value: WhipPublisher = {
    close: onClose,
    deleteResource: async () => { onDelete(); },
    stop: async () => undefined,
    republish: async () => value,
    setPublishToken: () => undefined,
  };
  return value;
}

function fakePage(): {
  root: HTMLElement;
  button: (selector: string) => FakeElement;
  step: (phase: string) => FakeElement;
} {
  const elements = new Map<string, FakeElement>();
  for (const selector of [
    '[data-screen-start]', '[data-screen-stop-others]', '[data-screen-retry]', '[data-screen-url]',
    '[data-screen-preview]', '[data-screen-audio-status]', '[data-screen-expiry-warning]',
    '[data-screen-error-message]', '[data-screen-flow-item]', '[data-screen-preview-toggle]',
    '[data-screen-preview-body]', '[data-screen-switch-track]', '[data-screen-switch-knob]',
    '[data-screen-expires-bar]', '[data-screen-audio-chip]', '[data-screen-audio-icon]',
    '[data-screen-audio-label]', '[data-screen-mode]',
  ]) elements.set(selector, new FakeElement());
  const steps = ['idle', 'login', 'live', 'error'].map((phase) => {
    const step = new FakeElement();
    step.dataset.screenStep = phase;
    return step;
  });
  const root = {
    dataset: {
      labelStart: 'start',
      labelSelecting: 'selecting', labelStarting: 'starting', audioOn: 'audio-on', audioOff: 'audio-off',
      labelStopOthers: 'stop-others',
      msgVideoOnly: 'video',
      msgDisplayDenied: 'denied',
      msgGeneric: 'error',
    },
    querySelector: (selector: string) => elements.get(selector) ?? null,
    querySelectorAll: (selector: string) => selector === '[data-screen-step]' ? steps : [],
  } as unknown as HTMLElement;
  return {
    root,
    button: (selector) => elements.get(selector)!,
    step: (phase) => steps.find((step) => step.dataset.screenStep === phase)!,
  };
}

class FakeElement {
  dataset: Record<string, string> = {};
  disabled = false;
  hidden = false;
  textContent = '';
  value = '';
  className = '';
  style = { width: '' };
  srcObject: MediaStream | null = null;
  private readonly attributes = new Map<string, string>();
  private readonly listeners: Array<() => void> = [];

  querySelector(): null { return null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(event: string, listener: () => void): void {
    if (event === 'click') this.listeners.push(listener);
  }
  click(): void { for (const listener of this.listeners) listener(); }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
