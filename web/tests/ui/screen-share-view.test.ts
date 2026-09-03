import { describe, expect, test } from 'bun:test';

import {
  EXPIRY_WARNING_SECONDS,
  HEARTBEAT_INTERVAL_MS,
  isExpiryWarning,
  releaseScreenShare,
  ScreenShareController,
  secondsUntil,
  type ScreenShareDependencies,
} from '../../src/lib/ui/screen-share';
import type { WhipPublisher } from '../../src/lib/ui/whip-publisher';
import { ScreenShareView } from '../../src/lib/ui/screen-share/view';

describe('画面共有の表示契約', () => {
  test('公開controllerは依存注入を省略した1引数constructorを維持する', () => {
    expect(() => new ScreenShareController(fakePage().root)).not.toThrow();
  });

  test('heartbeatと期限警告の境界を固定する', () => {
    const now = Date.parse('2026-09-01T00:00:00.000Z');
    const warningAt = new Date(now + EXPIRY_WARNING_SECONDS * 1000).toISOString();
    const later = new Date(now + (EXPIRY_WARNING_SECONDS + 1) * 1000).toISOString();

    expect(HEARTBEAT_INTERVAL_MS).toBe(25_000);
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThan(60_000);
    expect(secondsUntil(warningAt, now)).toBe(EXPIRY_WARNING_SECONDS);
    expect(isExpiryWarning(warningAt, now)).toBe(true);
    expect(isExpiryWarning(later, now)).toBe(false);
  });

  test('タイマー・画面共有・PeerConnectionをこの順で同期解放する', () => {
    const released: string[] = [];
    releaseScreenShare({
      publisher: publisher(() => { released.push('peerConnection'); }),
      media: { getTracks: () => [{ stop: () => { released.push('media'); } }] } as unknown as MediaStream,
    }, () => { released.push('timers'); });

    expect(released).toEqual(['timers', 'media', 'peerConnection']);
  });

  test('legacy releaseは同じMediaStreamのtrackだけを一度停止する', () => {
    const count = { timers: 0, tracks: 0, publishers: 0 };
    const media = {
      getTracks: () => [{ stop: () => { count.tracks += 1; } }],
    } as unknown as MediaStream;
    const live = {
      media,
      publisher: publisher(() => { count.publishers += 1; }),
    };
    const clearTimers = (): void => { count.timers += 1; };

    releaseScreenShare(live, clearTimers);
    releaseScreenShare(live, clearTimers);

    expect(count).toEqual({ timers: 2, tracks: 1, publishers: 2 });
  });

  test('期限警告の表示境界はisExpiryWarningの判定だけに従う', () => {
    const page = fakePage();
    const view = new ScreenShareView(page.root, { load: () => null, save: () => undefined });
    const now = Date.parse('2026-09-01T00:00:00.000Z');
    const warningAt = new Date(now + EXPIRY_WARNING_SECONDS * 1000).toISOString();
    const later = new Date(now + (EXPIRY_WARNING_SECONDS + 1) * 1000).toISOString();
    const warning = page.button('[data-screen-expiry-warning]');

    view.updateClock(nowIso(), now, EXPIRY_WARNING_SECONDS, isExpiryWarning(warningAt, now));
    expect(warning.hidden).toBe(false);

    view.updateClock(nowIso(), now, EXPIRY_WARNING_SECONDS + 1, isExpiryWarning(later, now));
    expect(warning.hidden).toBe(true);
  });

  test('開始から配信表示へ直行し、固定capture/sender設定を渡す', async () => {
    const page = fakePage();
    const calls: string[] = [];
    const counters = { stopped: 0, closed: 0, deleted: 0 };
    let requestedConstraints: MediaStreamConstraints | undefined;
    let publishedInput: Parameters<ScreenShareDependencies['startWhipPublisher']>[0] | undefined;
    const videoTrack = { addEventListener: () => undefined, stop: () => { counters.stopped += 1; } };
    const audioTrack = {
      contentHint: '',
      stop: () => { counters.stopped += 1; },
      getSettings: () => ({ channelCount: 2 }),
    };
    const media = {
      getTracks: () => [videoTrack, audioTrack],
      getVideoTracks: () => [videoTrack],
      getAudioTracks: () => [audioTrack],
    } as unknown as MediaStream;
    const livePublisher = publisher(
      () => { counters.closed += 1; },
      () => { counters.deleted += 1; }
    );
    const dependencies: ScreenShareDependencies = {
      requestJson: (async (path: string) => {
        calls.push(path);
        return path === '/api/streams/' ? createResponse() : null;
      }) as unknown as ScreenShareDependencies['requestJson'],
      startWhipPublisher: async (input) => {
        publishedInput = input;
        return livePublisher;
      },
      waitForStreamReady: async () => true,
      getDisplayMedia: async (constraints) => {
        requestedConstraints = constraints;
        return media;
      },
      previewPreference: { load: () => null, save: () => undefined },
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
      sendBeacon: () => true,
      onPageHide: () => undefined,
    };
    new ScreenShareController(page.root, dependencies).mount();

    page.button('[data-screen-start]').click();
    await waitFor(() => !page.step('live').hidden);
    expect(page.url.value).toBe('rtspt://webscreen.tv/live/Ab12Cd34Ef56');
    expect(page.button('[data-screen-audio-status]').textContent).toBe('audio-included');
    expect(page.button('[data-screen-audio-chip]').dataset.audio).toBe('on');
    expect(page.button('[data-screen-audio-label]').textContent).toBe('audio-on');
    expect(page.button('[data-screen-audio-icon]').className).toBe('fa-solid fa-volume-high');
    expect(requestedConstraints).toEqual({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    });
    expect(publishedInput?.audioProfile).toBe('raw');
    expect(publishedInput?.videoSettings).toMatchObject({
      maxBitrate: 1_200_000,
      contentHint: 'detail',
      degradationPreference: 'maintain-resolution',
      scaleResolutionDownBy: 1,
    });
    expect(audioTrack.contentHint).toBe('music');

    page.button('[data-screen-stop]').click();
    page.button('[data-screen-stop]').click();

    expect(counters).toEqual({ stopped: 2, closed: 1, deleted: 1 });
    expect(page.step('idle').hidden).toBe(false);
    expect(calls).toEqual(['/api/streams/', '/api/streams/Ab12Cd34Ef56/stop/']);
  });
});

function createResponse(): Record<string, unknown> {
  return {
    id: 'Ab12Cd34Ef56',
    streamUrl: 'rtspt://webscreen.tv/live/Ab12Cd34Ef56',
    status: 'live',
    publishToken: 'initial-token',
    publishTokenExpiresAt: '2026-09-01T01:00:00.000Z',
    extendExpiresAt: '2026-09-01T01:00:00.000Z',
    startedAt: '2026-09-01T00:00:00.000Z',
    lastHeartbeatAt: '2026-09-01T00:00:00.000Z',
    endedAt: null,
    endReason: null,
  };
}

function publisher(onClose = () => {}, onDelete = () => {}): WhipPublisher {
  const value: WhipPublisher = {
    close: onClose,
    deleteResource: async () => { onDelete(); },
    stop: async () => undefined,
    republish: async () => value,
    setPublishToken: () => undefined,
    videoStats: async () => null,
  };
  return value;
}

function fakePage(): {
  root: HTMLElement;
  button: (selector: string) => FakeElement;
  step: (phase: string) => FakeElement;
  url: FakeElement;
} {
  const elements = new Map<string, FakeElement>();
  for (const selector of [
    '[data-screen-start]', '[data-screen-copy]', '[data-screen-stop]', '[data-screen-retry]', '[data-screen-url]',
    '[data-screen-preview]', '[data-screen-elapsed]', '[data-screen-expires]',
    '[data-screen-expiry-warning]', '[data-screen-error-message]',
    '[data-screen-audio-status]', '[data-screen-stop-others]', '[data-screen-audio-chip]',
    '[data-screen-audio-icon]', '[data-screen-audio-label]',
  ]) elements.set(selector, new FakeElement());
  const steps = ['idle', 'login', 'starting', 'live', 'error'].map((phase) => {
    const step = new FakeElement();
    step.dataset.screenStep = phase;
    return step;
  });
  const root = {
    dataset: {
      labelStart: 'start', labelSelecting: 'selecting', labelCopy: 'copy', labelCopied: 'copied', labelRetry: 'retry',
      labelReconnect: 'reconnect', labelReconnecting: 'reconnecting', labelStopOthers: 'stop-others',
      msgGeneric: 'error', msgAudioIncluded: 'audio-included', msgVideoOnly: 'video-only',
      audioOn: 'audio-on', audioOff: 'audio-off',
    },
    querySelector: (selector: string) => elements.get(selector) ?? null,
    querySelectorAll: (selector: string) => selector === '[data-screen-step]' ? steps : [],
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
  paused = false;
  pause(): void { this.paused = true; }
  play(): Promise<void> { this.paused = false; return Promise.resolve(); }
  srcObject: MediaStream | null = null;
  textContent = '';
  value = '';
  className = '';
  private readonly listeners: Array<() => void> = [];
  querySelector(): null { return null; }
  addEventListener(event: string, listener: () => void): void {
    if (event === 'click') this.listeners.push(listener);
  }
  click(): void { for (const listener of this.listeners) listener(); }
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (condition()) return;
    await Promise.resolve();
  }
  throw new Error('Expected asynchronous UI update');
}

function nowIso(): string {
  return '2026-09-01T00:00:00.000Z';
}
