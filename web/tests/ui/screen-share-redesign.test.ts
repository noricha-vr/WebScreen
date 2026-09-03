import { describe, expect, jest, test } from 'bun:test';

import { ScreenShareController } from '../../src/lib/ui/screen-share';
import type { ScreenShareDependencies } from '../../src/lib/ui/screen-share';
import type { WhipPublisher } from '../../src/lib/ui/whip-publisher';

describe('画面共有リデザインの状態', () => {
  test('フローは常時表示され、ライブ中は URL 発行ステップを現在地にする', async () => {
    const page = fakePage();
    new ScreenShareController(page.root, dependencies()).mount();

    expect(page.currentFlowItems()).toEqual(['1']);
    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('live').hidden);

    expect(page.currentFlowItems()).toEqual(['2']);
    expect(page.flowItem('1').dataset.state).toBe('done');
  });

  test('ピッカー選択中は開始・再試行を無効化し、ラベルは span だけ差し替える', async () => {
    const page = fakePage();
    const start = page.button('[data-screen-start]');
    const retry = page.button('[data-screen-retry]');
    start.labelSpan = new FakeElement();
    start.labelSpan.textContent = 'start';
    retry.labelSpan = new FakeElement();
    let rejectPicker: ((reason: unknown) => void) | undefined;
    new ScreenShareController(page.root, dependencies({
      getDisplayMedia: () => new Promise((_resolve, reject) => { rejectPicker = reject; }),
    })).mount();

    start.click();
    expect(start.disabled).toBe(true);
    expect(retry.disabled).toBe(true);
    expect(start.labelSpan.textContent).toBe('selecting');

    rejectPicker!(new DOMException('denied', 'NotAllowedError'));
    await waitFor(() => !page.step('error').hidden);
    expect(start.disabled).toBe(false);
    expect(retry.disabled).toBe(false);
    expect(start.labelSpan.textContent).toBe('start');
    // button 直下（FontAwesome アイコン）を書き換えない
    expect(start.textContent).toBe('');
    expect(retry.textContent).toBe('');
  });

  test('画面選択後は配信準備中ラベルへ切り替える', async () => {
    const page = fakePage();
    const pendingCreate = deferred<Record<string, unknown>>();
    new ScreenShareController(page.root, dependencies({
      requestJson: async () => pendingCreate.promise,
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => page.button('[data-screen-start]').textContent === 'starting');

    expect(page.button('[data-screen-start]').disabled).toBe(true);
    pendingCreate.resolve(createResponse());
    await waitFor(() => !page.step('live').hidden);
  });

  test('プレビューを閉じても配信中の video を外さず、開閉状態を同期する', async () => {
    const page = fakePage();
    const track = { addEventListener: () => undefined, stop: () => undefined };
    const media = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream;
    new ScreenShareController(page.root, dependencies({ getDisplayMedia: async () => media })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('live').hidden);
    page.button('[data-screen-preview-toggle]').click();

    expect(page.button('[data-screen-preview-toggle]').getAttribute('aria-expanded')).toBe('false');
    expect(page.button('[data-screen-preview-body]').dataset.open).toBe('false');
    expect(page.button('[data-screen-switch-track]').dataset.open).toBe('false');
    expect(page.button('[data-screen-switch-knob]').dataset.open).toBe('false');
    expect(page.button('[data-screen-preview]').srcObject).toBe(media);
    expect(page.button('[data-screen-preview]').paused).toBe(true);

    page.button('[data-screen-preview-toggle]').click();
    expect(page.button('[data-screen-preview-body]').dataset.open).toBe('true');
    expect(page.button('[data-screen-preview]').paused).toBe(false);
  });

  test('期限バーは残り時間比を表示し、5分以下で警告色にする', async () => {
    jest.useFakeTimers();
    try {
      let now = Date.parse('2026-09-01T00:00:00.000Z');
      const page = fakePage();
      new ScreenShareController(page.root, dependencies({ now: () => now })).mount();

      page.button('[data-screen-start]').click();
      await waitFor(() => !page.step('live').hidden);
      now += 45 * 60 * 1000;
      jest.advanceTimersByTime(1_000);
      expect(page.button('[data-screen-expires-bar]').style.width).toBe('25%');

      now += 10 * 60 * 1000;
      jest.advanceTimersByTime(1_000);
      expect(page.button('[data-screen-expires-bar]').dataset.warning).toBe('true');
    } finally {
      jest.useRealTimers();
    }
  });

  test('15分経過時は配信をローカル終了し、停止APIを呼んでidleへ戻る', async () => {
    jest.useFakeTimers();
    try {
      let now = Date.parse('2026-09-01T00:00:00.000Z');
      const page = fakePage();
      const calls: string[] = [];
      const stopped = { capture: 0, peerConnection: 0, whipResource: 0 };
      const track = { addEventListener: () => undefined, stop: () => { stopped.capture += 1; } };
      const media = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream;
      const publisher: WhipPublisher = {
        close: () => { stopped.peerConnection += 1; },
        deleteResource: async () => { stopped.whipResource += 1; },
        stop: async () => undefined,
        republish: async () => publisher,
        setPublishToken: () => undefined,
      };
      new ScreenShareController(page.root, dependencies({
        now: () => now,
        getDisplayMedia: async () => media,
        startWhipPublisher: async () => publisher,
        requestJson: (async (url: string) => {
          calls.push(url);
          if (url === '/api/streams/') {
            return createResponse({
              publishTokenExpiresAt: '2026-09-01T00:15:00.000Z',
              extendExpiresAt: '2026-09-01T00:15:00.000Z',
            });
          }
          return null;
        }) as unknown as ScreenShareDependencies['requestJson'],
      })).mount();

      page.button('[data-screen-start]').click();
      await waitFor(() => !page.step('live').hidden);
      now += 15 * 60 * 1000;
      jest.advanceTimersByTime(15 * 60 * 1000);
      await waitFor(() => !page.step('idle').hidden);

      expect(stopped).toEqual({ capture: 1, peerConnection: 1, whipResource: 1 });
      expect(calls).toContain('/api/streams/Ab12Cd34Ef56/stop/');
    } finally {
      jest.useRealTimers();
    }
  });

  test('閉じたプレビューは、配信を止めて再開すると開いた状態に戻る', async () => {
    const page = fakePage();
    new ScreenShareController(page.root, dependencies()).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('live').hidden);
    page.button('[data-screen-preview-toggle]').click();
    expect(page.button('[data-screen-preview-body]').dataset.open).toBe('false');

    page.button('[data-screen-stop]').click();
    await waitFor(() => !page.step('idle').hidden);
    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('live').hidden);
    expect(page.button('[data-screen-preview-body]').dataset.open).toBe('true');
    expect(page.button('[data-screen-preview-toggle]').getAttribute('aria-expanded')).toBe('true');
  });
});

function dependencies(overrides: Partial<ScreenShareDependencies> = {}): ScreenShareDependencies {
  const track = { addEventListener: () => undefined, stop: () => undefined };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream;
  return {
    requestJson: (async () => createResponse()) as unknown as ScreenShareDependencies['requestJson'],
    startWhipPublisher: async () => publisher(),
    waitForStreamReady: async () => true,
    getDisplayMedia: async () => stream,
    now: () => Date.parse('2026-09-01T00:00:00.000Z'),
    sendBeacon: () => true,
    onPageHide: () => undefined,
    ...overrides,
  };
}

function createResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'Ab12Cd34Ef56', streamUrl: 'rtspt://webscreen.tv/live/Ab12Cd34Ef56', status: 'live',
    publishToken: 'token', publishTokenExpiresAt: '2026-09-01T01:00:00.000Z',
    extendExpiresAt: '2026-09-01T01:00:00.000Z', startedAt: '2026-09-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-09-01T00:00:00.000Z', endedAt: null, endReason: null,
    ...overrides,
  };
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function fakePage(): {
  root: HTMLElement;
  button: (selector: string) => FakeElement;
  step: (phase: string) => FakeElement;
  flowItem: (position: string) => FakeElement;
  currentFlowItems: () => string[];
} {
  const elements = new Map<string, FakeElement>();
  for (const selector of [
    '[data-screen-start]', '[data-screen-retry]', '[data-screen-stop]', '[data-screen-url]', '[data-screen-preview]', '[data-screen-elapsed]',
    '[data-screen-expires]', '[data-screen-expiry-warning]', '[data-screen-audio-status]',
    '[data-screen-preview-toggle]', '[data-screen-preview-body]', '[data-screen-switch-track]',
    '[data-screen-switch-knob]', '[data-screen-expires-bar]', '[data-screen-audio-chip]',
    '[data-screen-audio-icon]', '[data-screen-audio-label]',
  ]) elements.set(selector, new FakeElement());
  const steps = ['idle', 'login', 'live', 'error'].map((phase) => {
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
      labelStart: 'start', labelSelecting: 'selecting', labelStarting: 'starting', labelRetry: 'retry',
      msgVideoOnly: 'video', msgDisplayDenied: 'denied', audioOn: 'audio-on', audioOff: 'audio-off',
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
    flowItem: (position) => flowItems.find((item) => item.dataset.screenFlowItem === position)!,
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
  textContent = '';
  value = '';
  className = '';
  checked = false;
  input: FakeElement | null = null;
  style = { width: '' };
  srcObject: MediaStream | null = null;
  labelSpan: FakeElement | null = null;
  private readonly attributes = new Map<string, string>();
  private readonly listeners: Array<() => void> = [];

  querySelector(selector: string): FakeElement | null {
    if (selector === 'input') return this.input;
    if (selector === 'span') return this.labelSpan;
    return null;
  }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
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
