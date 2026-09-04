import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { ERROR_CODES } from '../../src/lib/contracts/api';
import { ScreenShareController } from '../../src/lib/ui/screen-share';
import type { ScreenShareDependencies } from '../../src/lib/ui/screen-share';
import type { MediaRecorderConstructor, RecorderInstance } from '../../src/lib/ui/screen-share/recorder';
import { JsonRequestError } from '../../src/lib/ui/request-json';
import type { WhipPublisher } from '../../src/lib/ui/whip-publisher';

let restoreDocument: () => void = () => undefined;

beforeEach(() => {
  restoreDocument = installFakeDocument();
});

afterEach(() => {
  restoreDocument();
});

describe('配信中パネルの録画', () => {
  test('停止するたびに一覧へ 1 件積み、空状態を隠す', async () => {
    const page = fakePage();
    const recorders = fakeRecorders();
    new ScreenShareController(page.root, dependencies({ MediaRecorder: recorders.Constructor })).mount();
    await startLive(page);

    page.button('[data-screen-record]').click();
    await waitFor(() => recorders.instances.length === 1);
    expect(page.button('[data-screen-record]').dataset.recording).toBe('true');
    expect(page.button('[data-screen-record-timer]').hidden).toBe(false);
    recorders.last().emit(2048);

    page.button('[data-screen-record]').click();
    await waitFor(() => page.button('[data-screen-record-list]').children.length === 1);

    expect(page.button('[data-screen-record-empty]').hidden).toBe(true);
    expect(page.button('[data-screen-record-list]').hidden).toBe(false);
    expect(page.button('[data-screen-record]').dataset.recording).toBe('false');
    expect(page.button('[data-screen-record-timer]').hidden).toBe(true);
    expect(page.texts()).toContain('録画 1.webm');
  });

  test('配信を終了すると録画も止まり、一覧へ積んでから画面を戻す', async () => {
    const page = fakePage();
    const recorders = fakeRecorders();
    new ScreenShareController(page.root, dependencies({ MediaRecorder: recorders.Constructor })).mount();
    await startLive(page);

    page.button('[data-screen-record]').click();
    await waitFor(() => recorders.instances.length === 1);
    recorders.last().emit(1024);

    page.button('[data-screen-stop]').click();
    await waitFor(() => page.button('[data-screen-record-list]').children.length === 1);

    expect(recorders.last().stopCalls).toBe(1);
    expect(page.step('idle').hidden).toBe(false);
  });

  test('録画停止と配信停止が重なっても一覧は 1 件で、MediaRecorder も一度しか止めない', async () => {
    const page = fakePage();
    const recorders = fakeRecorders();
    new ScreenShareController(page.root, dependencies({ MediaRecorder: recorders.Constructor })).mount();
    await startLive(page);

    page.button('[data-screen-record]').click();
    await waitFor(() => recorders.instances.length === 1);
    recorders.last().emit(512);

    page.button('[data-screen-record]').click();
    page.button('[data-screen-stop]').click();
    await waitFor(() => page.button('[data-screen-record-list]').children.length === 1);
    await Promise.resolve();

    expect(page.button('[data-screen-record-list]').children.length).toBe(1);
    expect(recorders.last().stopCalls).toBe(1);
  });

  test('録画できない環境では録画セクションに文言を出し、配信は続ける', async () => {
    const page = fakePage();
    const recorders = fakeRecorders({ supported: [] });
    new ScreenShareController(page.root, dependencies({ MediaRecorder: recorders.Constructor })).mount();
    await startLive(page);

    page.button('[data-screen-record]').click();
    await waitFor(() => !page.button('[data-screen-record-error]').hidden);

    expect(page.button('[data-screen-record-error]').textContent).toBe('record-unsupported');
    expect(page.step('live').hidden).toBe(false);
    expect(page.button('[data-screen-record]').dataset.recording).toBe('false');
  });
});

describe('配信中パネルの延長', () => {
  test('延長できたら期限を伸ばし、新しい publish token を publisher へ渡す', async () => {
    const page = fakePage();
    const tokens: string[] = [];
    new ScreenShareController(page.root, dependencies({}, { tokens })).mount();
    await startLive(page);
    expect(page.button('[data-screen-expires]').textContent).toBe('60:00');

    page.button('[data-screen-extend]').click();
    await waitFor(() => page.button('[data-screen-expires]').textContent === '120:00');

    expect(tokens).toEqual(['extended-token']);
    expect(page.button('[data-screen-live-error]').hidden).toBe(true);
    expect(page.button('[data-screen-extend]').disabled).toBe(false);
  });

  test('延長が無効なら配信中のまま理由を出し、ボタンを戻す', async () => {
    const page = fakePage();
    new ScreenShareController(page.root, dependencies({
      requestJson: (async (url: string) => {
        if (url.endsWith('/extend/')) throw new JsonRequestError(409, ERROR_CODES.streamExtensionDisabled);
        return url.endsWith('/stop/') ? null : createResponse();
      }) as unknown as ScreenShareDependencies['requestJson'],
    })).mount();
    await startLive(page);

    page.button('[data-screen-extend]').click();
    await waitFor(() => !page.button('[data-screen-live-error]').hidden);

    expect(page.button('[data-screen-live-error]').textContent).toBe('extension-disabled');
    expect(page.step('live').hidden).toBe(false);
    expect(page.button('[data-screen-extend]').disabled).toBe(false);
    expect(page.button('[data-screen-extend]').labelSpan?.textContent).toBe('extend');
  });
});

async function startLive(page: ReturnType<typeof fakePage>): Promise<void> {
  page.button('[data-screen-start]').click();
  await waitFor(() => !page.step('live').hidden);
}

function dependencies(
  overrides: Partial<ScreenShareDependencies> = {},
  hooks: { tokens?: string[] } = {}
): ScreenShareDependencies {
  const track = { addEventListener: () => undefined, stop: () => undefined };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream;
  return {
    requestJson: (async (url: string) => {
      if (url.endsWith('/extend/')) return {
        id: 'Ab12Cd34Ef56', status: 'live', publishToken: 'extended-token',
        publishTokenExpiresAt: '2026-09-01T03:00:00.000Z', extendExpiresAt: '2026-09-01T02:00:00.000Z',
      };
      if (url.endsWith('/stop/')) return null;
      return createResponse();
    }) as unknown as ScreenShareDependencies['requestJson'],
    startWhipPublisher: async () => publisher(hooks.tokens ?? []),
    waitForStreamReady: async () => true,
    getDisplayMedia: async () => stream,
    previewPreference: { load: () => null, save: () => undefined },
    now: () => Date.parse('2026-09-01T00:00:00.000Z'),
    sendBeacon: () => true,
    onPageHide: () => undefined,
    ...overrides,
  };
}

function createResponse(): Record<string, unknown> {
  return {
    id: 'Ab12Cd34Ef56', streamUrl: 'rtspt://webscreen.tv/live/Ab12Cd34Ef56',
    whipUrl: 'https://webscreen.tv/live/Ab12Cd34Ef56/whip', status: 'live',
    publishToken: 'token', publishTokenExpiresAt: '2026-09-01T01:00:00.000Z',
    extendExpiresAt: '2026-09-01T01:00:00.000Z', startedAt: '2026-09-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-09-01T00:00:00.000Z', endedAt: null, endReason: null,
  };
}

function publisher(tokens: string[]): WhipPublisher {
  return {
    close: () => undefined,
    deleteResource: async () => undefined,
    stop: async () => undefined,
    republish: async () => publisher(tokens),
    setPublishToken: (token: string) => { tokens.push(token); },
    videoStats: async () => null,
  };
}

/** 録画で使う MediaRecorder の差し替え。生成したインスタンスへテストから chunk を流す。 */
function fakeRecorders(options: { supported?: string[] } = {}): {
  Constructor: MediaRecorderConstructor;
  instances: FakeMediaRecorder[];
  last: () => FakeMediaRecorder;
} {
  const instances: FakeMediaRecorder[] = [];
  const supported = options.supported ?? ['video/webm'];
  class Constructor extends FakeMediaRecorder {
    static isTypeSupported(mimeType: string): boolean {
      return supported.includes(mimeType);
    }
    constructor(stream: MediaStream, init?: MediaRecorderOptions) {
      super(stream, init);
      instances.push(this);
    }
  }
  return {
    Constructor: Constructor as unknown as MediaRecorderConstructor,
    instances,
    last: () => instances[instances.length - 1]!,
  };
}

class FakeMediaRecorder implements RecorderInstance {
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType: string;
  stopCalls = 0;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(readonly stream: MediaStream, init?: MediaRecorderOptions) {
    this.mimeType = init?.mimeType ?? '';
  }

  start(): void { this.state = 'recording'; }

  stop(): void {
    this.stopCalls += 1;
    this.state = 'inactive';
    this.onstop?.();
  }

  emit(size: number): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) } as BlobEvent);
  }
}

/** 録画一覧は DOM を組み立てる。bun には document が無いので最小の生成器を差す。 */
function installFakeDocument(): () => void {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const original = Reflect.get(globalThis, 'document');
  Reflect.set(globalThis, 'document', { createElement: () => new FakeElement() });
  return () => {
    if (had) Reflect.set(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  };
}

function fakePage(): {
  root: HTMLElement;
  button: (selector: string) => FakeElement;
  step: (phase: string) => FakeElement;
  texts: () => string[];
} {
  const elements = new Map<string, FakeElement>();
  for (const selector of [
    '[data-screen-start]', '[data-screen-retry]', '[data-screen-stop]', '[data-screen-url]',
    '[data-screen-preview]', '[data-screen-elapsed]', '[data-screen-expires]',
    '[data-screen-expiry-warning]', '[data-screen-audio-status]', '[data-screen-expires-bar]',
    '[data-screen-audio-chip]', '[data-screen-audio-icon]', '[data-screen-audio-label]',
    '[data-screen-extend]', '[data-screen-live-error]', '[data-screen-record]',
    '[data-screen-record-icon]', '[data-screen-record-timer]', '[data-screen-record-elapsed]',
    '[data-screen-record-error]', '[data-screen-record-empty]', '[data-screen-record-list]',
  ]) elements.set(selector, new FakeElement());
  for (const selector of ['[data-screen-extend]', '[data-screen-record]']) {
    elements.get(selector)!.labelSpan = new FakeElement();
  }
  const steps = ['idle', 'login', 'starting', 'live', 'error'].map((phase) => {
    const step = new FakeElement();
    step.dataset.screenStep = phase;
    return step;
  });
  const root = {
    dataset: {
      labelStart: 'start', labelSelecting: 'selecting', labelStarting: 'starting', labelRetry: 'retry',
      labelExtend: 'extend', labelRecordStart: 'rec-start', labelRecordStop: 'rec-stop',
      labelRecordDownload: 'download', labelRecordSaved: 'saved',
      recordFilenameBase: '録画 {number}', recordDetails: '{time} 開始 ・ {duration} ・ {size} MB',
      msgRecordUnsupported: 'record-unsupported', msgRecordWriteFailed: 'record-write-failed',
      msgRecordSizeLimit: 'record-size-limit', msgStreamExtensionDisabled: 'extension-disabled',
      msgVideoOnly: 'video', msgDisplayDenied: 'denied', audioOn: 'audio-on', audioOff: 'audio-off',
    },
    querySelector: (selector: string) => elements.get(selector) ?? null,
    querySelectorAll: (selector: string) => (selector === '[data-screen-step]' ? steps : []),
  } as unknown as HTMLElement;
  return {
    root,
    button: (selector) => elements.get(selector)!,
    step: (phase) => steps.find((step) => step.dataset.screenStep === phase)!,
    texts: () => elements.get('[data-screen-record-list]')!.descendantTexts(),
  };
}

class FakeElement {
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  disabled = false;
  hidden = false;
  paused = false;
  textContent = '';
  value = '';
  className = '';
  type = '';
  style = { width: '' };
  srcObject: MediaStream | null = null;
  labelSpan: FakeElement | null = null;
  private readonly attributes = new Map<string, string>();
  private readonly listeners: Array<() => void> = [];

  pause(): void { this.paused = true; }
  play(): Promise<void> { this.paused = false; return Promise.resolve(); }
  querySelector(selector: string): FakeElement | null { return selector === 'span' ? this.labelSpan : null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  addEventListener(event: string, listener: () => void): void { if (event === 'click') this.listeners.push(listener); }
  click(): void { for (const listener of this.listeners) listener(); }
  append(...children: FakeElement[]): void {
    this.children.push(...children);
    // 生成直後の要素は span を label として引けるようにする（setButtonLabel と同じ経路）。
    this.labelSpan ??= children.find((child) => child.textContent !== '') ?? null;
  }
  prepend(child: FakeElement): void { this.children.unshift(child); }
  descendantTexts(): string[] {
    return this.children.flatMap((child) => [child.textContent, ...child.descendantTexts()])
      .filter((text) => text.length > 0);
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error('Expected asynchronous UI update');
}
