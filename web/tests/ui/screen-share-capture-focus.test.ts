import { describe, expect, test } from 'bun:test';

import { getDisplayMediaKeepingFocus } from '../../src/lib/ui/screen-share/capture';

describe('画面選択後のフォーカス維持', () => {
  const constraints: DisplayMediaStreamOptions = { video: true };

  test('CaptureController が無いブラウザでは constraints をそのまま渡す', async () => {
    const passed: DisplayMediaStreamOptions[] = [];
    const stream = fakeStream('browser');
    const result = await getDisplayMediaKeepingFocus(constraints, async (options) => { passed.push(options); return stream; }, null);

    expect(result).toBe(stream);
    expect(passed).toEqual([{ video: true }]);
  });

  test.each(['browser', 'window'])(
    '%s 共有では解決直後に no-focus-change を設定し WebScreen に留まる',
    async (surface) => {
      const controller = fakeController();
      let passedController: unknown;
      await getDisplayMediaKeepingFocus(
        constraints,
        async (options) => { passedController = options.controller; return fakeStream(surface); },
        () => controller.instance
      );

      expect(passedController).toBe(controller.instance);
      expect(controller.calls).toEqual(['no-focus-change']);
    }
  );

  test('monitor 共有では setFocusBehavior を呼ばない（画面全体はフォーカス対象にできない）', async () => {
    const controller = fakeController();
    await getDisplayMediaKeepingFocus(constraints, async () => fakeStream('monitor'), () => controller.instance);

    expect(controller.calls).toEqual([]);
  });

  test('setFocusBehavior が拒否されても stream は返す', async () => {
    const controller = fakeController(() => { throw new DOMException('late', 'InvalidStateError'); });
    const stream = fakeStream('window');
    const originalWarn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args[0]); };
    try {
      await expect(getDisplayMediaKeepingFocus(constraints, async () => stream, () => controller.instance)).resolves.toBe(stream);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toHaveLength(1);
  });
});

function fakeStream(displaySurface: string): MediaStream {
  return { getVideoTracks: () => [{ getSettings: () => ({ displaySurface }) }] } as unknown as MediaStream;
}

function fakeController(onSet?: () => void): { instance: CaptureController; calls: string[] } {
  const calls: string[] = [];
  const instance = {
    setFocusBehavior(behavior: string) { calls.push(behavior); onSet?.(); },
  } as unknown as CaptureController;
  return { instance, calls };
}
