import { afterEach, describe, expect, test } from 'bun:test';

import {
  browserPreviewPreference,
  SCREEN_SHARE_PREVIEW_PREFERENCE_KEY,
} from '../../src/lib/ui/screen-share/preview-preference';

const originalWindow = globalThis.window;

afterEach(() => {
  Object.assign(globalThis, { window: originalWindow });
});

describe('プレビュー表示設定の localStorage 境界', () => {
  test('未保存・不正値は null、true/false は boolean に復元する', () => {
    const storage = installStorage();
    expect(browserPreviewPreference.load()).toBeNull();
    storage.set(SCREEN_SHARE_PREVIEW_PREFERENCE_KEY, 'maybe');
    expect(browserPreviewPreference.load()).toBeNull();
    storage.set(SCREEN_SHARE_PREVIEW_PREFERENCE_KEY, 'false');
    expect(browserPreviewPreference.load()).toBe(false);
    storage.set(SCREEN_SHARE_PREVIEW_PREFERENCE_KEY, 'true');
    expect(browserPreviewPreference.load()).toBe(true);
  });

  test('save は名前空間付きキーへ true/false 文字列で書き、load で往復する', () => {
    const storage = installStorage();
    browserPreviewPreference.save(false);
    expect(storage.get(SCREEN_SHARE_PREVIEW_PREFERENCE_KEY)).toBe('false');
    expect(browserPreviewPreference.load()).toBe(false);
    browserPreviewPreference.save(true);
    expect(browserPreviewPreference.load()).toBe(true);
  });

  test('localStorage が SecurityError で使えない時は load が null、save が例外を投げない', () => {
    Object.assign(globalThis, {
      window: {
        get localStorage(): Storage { throw new DOMException('blocked', 'SecurityError'); },
      },
    });
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
      expect(browserPreviewPreference.load()).toBeNull();
      expect(() => browserPreviewPreference.save(false)).not.toThrow();
    } finally {
      console.warn = originalWarn;
    }
  });
});

function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  Object.assign(globalThis, {
    window: {
      localStorage: {
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => { map.set(key, value); },
      },
    },
  });
  return map;
}
