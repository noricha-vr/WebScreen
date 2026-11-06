import { describe, expect, test } from 'bun:test';

import { loadSecondsPerFrame, mountConvertSettings, saveSecondsPerFrame } from '../../src/lib/ui/convert-settings';
import en from '../../src/i18n/en.json';
import ja from '../../src/i18n/ja.json';

function storageFake(initial: string | null = null) {
  let value = initial;
  let writtenKey = '';
  return {
    getItem: (key: string) => { expect(key).toBe('webscreen:seconds-per-frame'); return value; },
    setItem: (key: string, next: string) => { writtenKey = key; value = next; },
    value: () => value,
    writtenKey: () => writtenKey,
  };
}

function panelFake(template: string) {
  const radios = [1, 2].map((value) => ({
    value: String(value), checked: false,
    change: () => {},
    addEventListener(_event: string, callback: () => void) { this.change = callback; },
  }));
  const summary = { textContent: '', dataset: { template } };
  const example = { textContent: '' };
  return {
    radios, summary, example,
    querySelector: (selector: string) => selector === '[data-settings-summary]' ? summary : example,
    querySelectorAll: () => radios,
  };
}

function withStorage<T>(storage: object, run: () => T): T {
  const originalWindow = globalThis.window;
  Object.assign(globalThis, { window: storage });
  try { return run(); }
  finally { Object.assign(globalThis, { window: originalWindow }); }
}

describe('表示秒数の保存・復元', () => {
  test.each([1, 2] as const)('%s 秒を既存の名前空間で保存し復元する', (seconds) => {
    const storage = storageFake();
    saveSecondsPerFrame(seconds, storage);
    expect(storage.writtenKey()).toBe('webscreen:seconds-per-frame');
    expect(storage.value()).toBe(String(seconds));
    expect(loadSecondsPerFrame(storage)).toBe(seconds);
  });

  test.each([null, '', '0', '3', '-1', '2.0', ' 2', '02', 'NaN', 'undefined'])('不正な保存値 %s は 1 秒へ戻す', (value) => {
    expect(loadSecondsPerFrame(storageFake(value))).toBe(1);
  });

  test('ストレージの読み書きが例外でも既定値で動く', () => {
    const storage = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('quota exceeded'); },
    };
    expect(loadSecondsPerFrame(storage)).toBe(1);
    expect(() => saveSecondsPerFrame(2, storage)).not.toThrow();
  });

  test('localStorage 自体へのアクセスが拒否されても動く', () => {
    withStorage({ get localStorage() { throw new Error('SecurityError'); } }, () => {
      expect(loadSecondsPerFrame()).toBe(1);
      expect(() => saveSecondsPerFrame(2)).not.toThrow();
      const panel = panelFake(ja.convert.settingsSummary);
      const selected = mountConvertSettings(panel as unknown as HTMLElement);
      expect(selected()).toBe(1);
      panel.radios[1]!.checked = true;
      expect(() => panel.radios[1]!.change()).not.toThrow();
      expect(selected()).toBe(2);
      expect(panel.example.textContent).toBe('24');
    });
  });
});

for (const dictionary of [ja, en]) {
  test('復元・選択に合わせてラジオ、要約、12 ページの例を更新する', () => {
    const storage = storageFake('2');
    withStorage({ localStorage: storage }, () => {
      const panel = panelFake(dictionary.convert.settingsSummary);
      const selected = mountConvertSettings(panel as unknown as HTMLElement);
      expect(selected()).toBe(2);
      expect(panel.radios.map((radio) => radio.checked)).toEqual([false, true]);
      expect(panel.summary.textContent).toBe(dictionary.convert.settingsSummary.replace('{seconds}', '2'));
      expect(panel.example.textContent).toBe('24');
      panel.radios[0]!.checked = true;
      panel.radios[0]!.change();
      expect(selected()).toBe(1);
      expect(storage.value()).toBe('1');
      expect(panel.radios.map((radio) => radio.checked)).toEqual([true, false]);
      expect(panel.summary.textContent).toBe(dictionary.convert.settingsSummary.replace('{seconds}', '1'));
      expect(panel.example.textContent).toBe('12');
    });
  });
}
