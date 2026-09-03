import { describe, expect, test } from 'bun:test';

import { ScreenShareController, type ScreenShareDependencies } from '../../src/lib/ui/screen-share';
import type { WhipPublisher } from '../../src/lib/ui/whip-publisher';
import type { ClientErrorReport } from '../../src/lib/contracts/client-error';

describe('画面共有の再接続', () => {
  test('初回healthが二度失敗しても画面を保持し、再接続だけで配信表示へ進む', async () => {
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
    await waitFor(() => !page.step('live').hidden);
    expect(selections).toBe(1);
    expect(healthChecks).toBe(3);
    expect(page.url.value).toBe('rtspt://webscreen.tv/live/Ab12Cd34Ef56');
  });

  test('初回healthが失敗し復旧のrepublishも失敗したら、WHIPエラーではなく映像未到達（unhealthy）を表示しやり直しへ導く', async () => {
    const page = fakePage();
    let selections = 0;
    const healthy = publisher();
    // bytesSent>0（映像は出ているが health 未達）にして no-video 短絡を回避し、
    // republish 経路を確実に通す。close 前採取の stats が healthTimeout として残ることを検証。
    const broken = Object.assign(publisher(async () => { throw new Error('republish failed'); }), {
      videoStats: async () => ({ bytesSent: 4096, framesEncoded: 0 }),
    });
    const reports: ClientErrorReport[] = [];
    let call = 0;
    new ScreenShareController(page.root, dependencies({
      // 1回目: republish が失敗する publisher。2回目のやり直しでは health が通る publisher。
      startWhipPublisher: async () => (++call === 1 ? broken : healthy),
      waitForStreamReady: async () => call >= 2,
      getDisplayMedia: async () => { selections += 1; return media(); },
      reportStreamFailure: (report) => { reports.push(report); },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    // 初回 publish は成立しているので「サーバーに接続できない」ではなく映像未到達を案内する。
    expect(page.button('[data-screen-error-message]').textContent).toBe('unhealthy');
    // bytes は流れていたので healthTimeout（noVideo ではない）を 1 回だけ報告する。
    expect(reports).toEqual([{ stage: 'stream', errorCode: 'streamHealthTimeout' }]);
    // 死んだ publisher を残さないので再接続ではなく、画面を選び直すやり直しに導く。
    expect(page.button('[data-screen-retry]').textContent).toBe('retry');
    expect(selections).toBe(1);

    page.button('[data-screen-retry]').click();
    await waitFor(() => !page.step('live').hidden);
    expect(selections).toBe(2);
  });

  test('初回healthが失敗しbytesSent===0（H.264未生成）なら republish せず即 noVideo 表示', async () => {
    const page = fakePage();
    let selections = 0;
    let republishes = 0;
    let healthChecks = 0;
    const reports: ClientErrorReport[] = [];
    const noVideo = Object.assign(publisher(async () => { republishes += 1; throw new Error('unused'); }), {
      videoStats: async () => ({ bytesSent: 0, framesEncoded: 0 }),
    });
    new ScreenShareController(page.root, dependencies({
      startWhipPublisher: async () => noVideo,
      waitForStreamReady: async () => { healthChecks += 1; return false; },
      getDisplayMedia: async () => { selections += 1; return media(); },
      reportStreamFailure: (report) => { reports.push(report); },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    // 2回目の health 待機を挟まず短絡する（health は1回だけ・republish は呼ばれない）。
    expect(healthChecks).toBe(1);
    expect(republishes).toBe(0);
    expect(reports).toEqual([{ stage: 'stream', errorCode: 'streamNoVideo' }]);
    // publisher は stream に載ったまま（既存 ready:false 経路）なので reconnect ラベル。
    expect(page.button('[data-screen-retry]').textContent).toBe('reconnect');
    expect(selections).toBe(1);
  });

  test('bytesSentがundefined（レポート欠落）では短絡せず republish を試みる', async () => {
    const page = fakePage();
    let republishes = 0;
    const reports: ClientErrorReport[] = [];
    const recovered = publisher();
    const missing = Object.assign(publisher(async () => { republishes += 1; return recovered; }), {
      videoStats: async () => ({ bytesSent: undefined, framesEncoded: undefined }),
    });
    new ScreenShareController(page.root, dependencies({
      startWhipPublisher: async () => missing,
      waitForStreamReady: async () => false,
      getDisplayMedia: async () => media(),
      reportStreamFailure: (report) => { reports.push(report); },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    // undefined は「0 と観測できた」に当たらないので短絡せず republish する。
    expect(republishes).toBe(1);
    expect(reports).toEqual([{ stage: 'stream', errorCode: 'streamStatsUnavailable' }]);
  });

  test('healthがreadyでも映像bytesSent===0なら live にせず streamNoVideo（音声だけ流れた場合）', async () => {
    const page = fakePage();
    let republishes = 0;
    const reports: ClientErrorReport[] = [];
    // path 全体 bytes（音声込み）で health は ready だが、映像は 1 バイトも出ていない。
    const audioOnly = Object.assign(publisher(async () => { republishes += 1; throw new Error('unused'); }), {
      videoStats: async () => ({ bytesSent: 0, framesEncoded: 0 }),
    });
    new ScreenShareController(page.root, dependencies({
      startWhipPublisher: async () => audioOnly,
      waitForStreamReady: async () => true,
      reportStreamFailure: (report) => { reports.push(report); },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    expect(page.step('live').hidden).toBe(true);
    expect(republishes).toBe(0);
    expect(reports).toEqual([{ stage: 'stream', errorCode: 'streamNoVideo' }]);
  });

  test('republish成功後に現publisherが取得不能(null)なら旧値へフォールバックせず statsUnavailable', async () => {
    const page = fakePage();
    const reports: ClientErrorReport[] = [];
    const replacement = publisher(); // 既定の videoStats は null
    // 初回は bytesSent>0（no-video 短絡を回避）だが health 未達 → republish 成功 → 以後も未達。
    const original = Object.assign(publisher(async () => replacement), {
      videoStats: async () => ({ bytesSent: 100, framesEncoded: 0 }),
    });
    new ScreenShareController(page.root, dependencies({
      startWhipPublisher: async () => original,
      waitForStreamReady: async () => false,
      reportStreamFailure: (report) => { reports.push(report); },
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    // 旧 publisher の bytesSent:100 に化けず、現 publisher の null → statsUnavailable。
    expect(reports).toEqual([{ stage: 'stream', errorCode: 'streamStatsUnavailable' }]);
  });

  test('自動republish後のhealthがreadyでも現publisherの映像が0バイトならreadyを送らない', async () => {
    const page = fakePage();
    const analytics: string[] = [];
    const replacement = Object.assign(publisher(), {
      videoStats: async () => ({ bytesSent: 0, framesEncoded: 0 }),
    });
    const original = Object.assign(publisher(async () => replacement), {
      videoStats: async () => ({ bytesSent: 100, framesEncoded: 1 }),
    });
    let healthChecks = 0;
    new ScreenShareController(page.root, dependencies({
      startWhipPublisher: async () => original,
      waitForStreamReady: async () => ++healthChecks === 2,
      trackAnalytics: (event) => analytics.push(event),
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);

    expect(page.step('live').hidden).toBe(true);
    expect(analytics).toEqual(['screen_share_start']);
  });

  test('手動retryのhealthがreadyでも現publisherの映像が0バイトならreadyを送らない', async () => {
    const page = fakePage();
    const analytics: string[] = [];
    const replacement = Object.assign(publisher(), {
      videoStats: async () => ({ bytesSent: 0, framesEncoded: 0 }),
    });
    const original = Object.assign(publisher(async () => replacement), {
      videoStats: async () => ({ bytesSent: 0, framesEncoded: 0 }),
    });
    new ScreenShareController(page.root, dependencies({
      startWhipPublisher: async () => original,
      waitForStreamReady: async () => true,
      trackAnalytics: (event) => analytics.push(event),
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    page.button('[data-screen-retry]').click();
    await flushMicrotasks();

    expect(page.step('live').hidden).toBe(true);
    expect(analytics).toEqual(['screen_share_start']);
  });

  test('videoStats待機中に停止したら idle 維持・error 非表示・publisher解放（復活させない）', async () => {
    const page = fakePage();
    const pendingStats = deferred<{ bytesSent: number; framesEncoded: number }>();
    let statsRequested = false;
    const count = { close: 0, delete: 0 };
    const target = Object.assign(publisher(), {
      videoStats: () => { statsRequested = true; return pendingStats.promise; },
      close: () => { count.close += 1; },
      deleteResource: async () => { count.delete += 1; },
    });
    new ScreenShareController(page.root, dependencies({
      startWhipPublisher: async () => target,
      waitForStreamReady: async () => false,
      getDisplayMedia: async () => media(),
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => statsRequested);
    page.button('[data-screen-stop]').click();
    pendingStats.resolve({ bytesSent: 0, framesEncoded: 0 });
    await flushMicrotasks();

    expect(page.step('idle').hidden).toBe(false);
    expect(page.step('error').hidden).toBe(true);
    expect(count.close).toBeGreaterThanOrEqual(1);
    expect(count.delete).toBeGreaterThanOrEqual(1);
  });

  test('no-video失敗→再接続成功(live)で診断ボタンが隠れる（古い診断を残さない）', async () => {
    const page = fakePage();
    let reconnected = false;
    const healthy = publisher();
    const noVideo = Object.assign(publisher(async () => { reconnected = true; return healthy; }), {
      videoStats: async () => ({ bytesSent: 0, framesEncoded: 0 }),
    });
    new ScreenShareController(page.root, dependencies({
      startWhipPublisher: async () => noVideo,
      // 初回は false（no-video 短絡）、再接続の republish 後は true（live 成功）。
      waitForStreamReady: async () => reconnected,
    })).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('error').hidden);
    // no-video 診断があるのでコピーボタンは表示。
    expect(page.button('[data-screen-copy-diagnostics]').hidden).toBe(false);

    page.button('[data-screen-retry]').click();
    await waitFor(() => !page.step('live').hidden);
    // live 成功で診断は捨てる → 後続の別エラーで古い診断をコピーさせない。
    expect(page.button('[data-screen-copy-diagnostics]').hidden).toBe(true);
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
    previewPreference: { load: () => null, save: () => undefined },
    now: () => Date.parse('2026-09-01T00:00:00.000Z'),
    sendBeacon: () => true,
    onPageHide: () => undefined,
    reportStreamFailure: () => undefined,
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
    videoStats: async () => null,
  };
}

function fakePage(): { root: HTMLElement; button: (selector: string) => FakeElement; step: (phase: string) => FakeElement; url: FakeElement } {
  const elements = new Map<string, FakeElement>();
  for (const selector of [
    '[data-screen-start]', '[data-screen-copy]',
    '[data-screen-stop]', '[data-screen-retry]', '[data-screen-url]', '[data-screen-preview]',
    '[data-screen-expiry-warning]', '[data-screen-error-message]',
    '[data-screen-audio-status]', '[data-screen-stop-others]', '[data-screen-copy-diagnostics]',
  ]) elements.set(selector, new FakeElement());
  const steps = ['idle', 'login', 'starting', 'live', 'error'].map((phase) => {
    const step = new FakeElement(); step.dataset.screenStep = phase; return step;
  });
  const root = {
    dataset: {
      labelStart: 'start', labelSelecting: 'selecting', labelRetry: 'retry',
      labelReconnect: 'reconnect', labelReconnecting: 'reconnecting', labelStopOthers: 'stop-others',
      labelDiagnosticsCopy: 'copy-diag', labelDiagnosticsCopied: 'copied-diag',
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
  paused = false;
  pause(): void { this.paused = true; }
  play(): Promise<void> { this.paused = false; return Promise.resolve(); }
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
