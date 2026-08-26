import { describe, expect, test } from 'bun:test';

import { consumeAutoCopy, markAutoCopy } from '../../src/lib/ui/auto-copy';

class FakeStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('自動コピーの one-shot フラグ', () => {
  test('同じ shortId なら true を返してフラグを削除する', () => {
    const storage = new FakeStorage();
    markAutoCopy('Ab12Cd34Ef56', storage);

    expect(consumeAutoCopy('Ab12Cd34Ef56', storage)).toBe(true);
    expect(consumeAutoCopy('Ab12Cd34Ef56', storage)).toBe(false);
  });

  test('別の shortId でも stale フラグを削除して false を返す', () => {
    const storage = new FakeStorage();
    markAutoCopy('Ab12Cd34Ef56', storage);

    expect(consumeAutoCopy('Zy98Xw76Vu54', storage)).toBe(false);
    expect(consumeAutoCopy('Ab12Cd34Ef56', storage)).toBe(false);
  });

  test('フラグが無ければ false を返す', () => {
    expect(consumeAutoCopy('Ab12Cd34Ef56', new FakeStorage())).toBe(false);
  });

  test('ストレージが使えなくても例外を出さず false を返す', () => {
    const unavailableStorage = {
      getItem(): string | null {
        throw new Error('storage unavailable');
      },
      removeItem(): void {
        throw new Error('storage unavailable');
      },
      setItem(): void {
        throw new Error('storage unavailable');
      },
    };

    expect(() => markAutoCopy('Ab12Cd34Ef56', unavailableStorage)).not.toThrow();
    expect(consumeAutoCopy('Ab12Cd34Ef56', unavailableStorage)).toBe(false);
  });
});
