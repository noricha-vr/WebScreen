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
    let stopped = 0;
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
      getDisplayMedia: async () => media(() => { stopped += 1; }),
      delay: () => new Promise<void>((resolve) => { resolveDelay = resolve; }),
      onPageHide: (handler) => { pageHide = handler; },
    }));
    controller.mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    page.button('[data-screen-stop-others]').click();
    await waitFor(() => resolveDelay !== undefined);
    expect(page.button('[data-screen-retry]').disabled).toBe(true);
    pageHide?.();
    resolveDelay?.();
    await flushMicrotasks();

    expect(creates).toBe(1);
    expect(stopped).toBeGreaterThanOrEqual(2);
    expect(page.button('[data-screen-retry]').disabled).toBe(false);
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
