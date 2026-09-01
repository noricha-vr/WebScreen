import { describe, expect, test } from 'bun:test';

import {
  EXPIRY_WARNING_SECONDS,
  HEARTBEAT_INTERVAL_MS,
  isExpiryWarning,
  nextStreamStep,
  releaseScreenShare,
  ScreenShareController,
  secondsUntil,
} from '../../src/lib/ui/screen-share';
import type { ScreenShareDependencies } from '../../src/lib/ui/screen-share';
import type { WhipPublisher } from '../../src/lib/ui/whip-publisher';

describe('画面共有ウィザードの状態', () => {
  test('配信 URL の確認後だけライブ画面へ進める', () => {
    expect(nextStreamStep('url')).toBe('live');
    expect(nextStreamStep('live')).toBeNull();
  });
});

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
  test('WHIP の DELETE が失敗してもローカルの画面共有とタイマーを必ず止める', async () => {
    let stopped = 0;
    let timersCleared = 0;
    const closeError = await releaseScreenShare(
      {
        publisher: {
          close: async () => { throw new Error('network failure'); },
          setPublishToken: () => undefined,
        },
        media: { getTracks: () => [{ stop: () => { stopped += 1; } }] } as unknown as MediaStream,
      },
      () => { timersCleared += 1; }
    );

    expect(closeError).toBeInstanceOf(Error);
    expect(stopped).toBe(1);
    expect(timersCleared).toBe(1);
  });
});

describe('画面共有 controller', () => {
  test('heartbeat・延長・通信失敗時の後始末を API 応答に従って実行する', async () => {
    const calls: string[] = [];
    let token = '';
    let stopped = 0;
    let closed = 0;
    const controls = new Map<string, { disabled?: boolean; textContent?: string; hidden?: boolean }>();
    for (const selector of [
      '[data-screen-extend]',
      '[data-screen-stop]',
      '[data-screen-elapsed]',
      '[data-screen-expires]',
      '[data-screen-expiry-warning]',
      '[data-screen-error-message]',
    ]) controls.set(selector, {});
    const root = {
      dataset: { labelExtending: 'extending', labelExtend: 'extend', msgGeneric: 'error' },
      querySelector: (selector: string) => controls.get(selector) ?? null,
      querySelectorAll: () => [],
    } as unknown as HTMLElement;
    const publisher: WhipPublisher = {
      close: async () => { closed += 1; },
      setPublishToken: (value) => { token = value; },
    };
    const dependencies: ScreenShareDependencies = {
      requestJson: (async (path: string) => {
        calls.push(path);
        if (path.endsWith('/extend/')) {
          return {
            id: 'Ab12Cd34Ef56', status: 'live', publishToken: 'extended-token',
            publishTokenExpiresAt: '2026-09-01T02:00:00.000Z',
            extendExpiresAt: '2026-09-01T02:00:00.000Z',
          };
        }
        if (path.endsWith('/heartbeat/')) throw new Error('network failure');
        return undefined;
      }) as unknown as ScreenShareDependencies['requestJson'],
      startWhipPublisher: async () => publisher,
      getDisplayMedia: async () => ({ getTracks: () => [] }) as unknown as MediaStream,
      now: () => Date.parse('2026-09-01T00:00:00.000Z'),
    };
    const controller = new ScreenShareController(root, dependencies);
    const live = {
      id: 'Ab12Cd34Ef56', streamUrl: 'rtspt://webscreen.tv/live/Ab12Cd34Ef56',
      publishToken: 'initial-token', publishTokenExpiresAt: '2026-09-01T01:00:00.000Z',
      extendExpiresAt: '2026-09-01T01:00:00.000Z', status: 'live' as const,
      startedAt: '2026-09-01T00:00:00.000Z', lastHeartbeatAt: '2026-09-01T00:00:00.000Z',
      endedAt: null, endReason: null,
      publisher,
      media: { getTracks: () => [{ stop: () => { stopped += 1; } }] } as unknown as MediaStream,
    };
    (controller as unknown as { live: typeof live }).live = live;

    await (controller as unknown as { extend: () => Promise<void> }).extend();
    expect(token).toBe('extended-token');
    expect(live.extendExpiresAt).toBe('2026-09-01T02:00:00.000Z');

    await (controller as unknown as { heartbeat: () => Promise<void> }).heartbeat();
    expect(calls).toEqual([
      '/api/streams/Ab12Cd34Ef56/extend/',
      '/api/streams/Ab12Cd34Ef56/heartbeat/',
    ]);
    expect(closed).toBe(1);
    expect(stopped).toBe(1);
    expect((controller as unknown as { live: unknown }).live).toBeNull();
  });
});
