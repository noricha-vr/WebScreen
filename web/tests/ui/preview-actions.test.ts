import { afterEach, describe, expect, test } from 'bun:test';

import { markAutoCopy } from '../../src/lib/ui/auto-copy';
import { mountPreviewActions } from '../../src/lib/ui/preview-actions';

const SHORT_ID = 'Ab12Cd34Ef56';
const PUBLIC_URL = 'https://public.example/movies/Ab12Cd34Ef56.mp4';

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

/** URL 入力欄と shortId だけを持つ最小のプレビュー（pin / rename / 削除は所有者だけの要素）。 */
class FakePreview {
  readonly dataset: Record<string, string> = { shortId: SHORT_ID };
  readonly input = { value: PUBLIC_URL, select(): void {} };

  querySelector(selector: string): unknown {
    return selector === '[data-preview-url]' ? this.input : null;
  }
}

interface ScheduledCall {
  callback: () => void;
  delayMs: number;
}

function mount(storage: FakeStorage): { preview: FakePreview; scheduled: ScheduledCall[] } {
  const preview = new FakePreview();
  const scheduled: ScheduledCall[] = [];
  mountPreviewActions(preview as unknown as HTMLElement, {
    storage,
    schedule: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
    },
  });
  return { preview, scheduled };
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

/** navigator.clipboard を差し替えて writeText の呼び出しを記録する。 */
function stubClipboard(): { writes: string[] } {
  const writes: string[] = [];
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      clipboard: {
        writeText(value: string): Promise<void> {
          writes.push(value);
          return Promise.resolve();
        },
      },
    },
    configurable: true,
    writable: true,
  });
  return { writes };
}

afterEach(() => {
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

describe('プレビューの自動コピー', () => {
  test('コピーは即時、「コピーしました」の表示だけ 0.5 秒遅らせる', async () => {
    const clipboard = stubClipboard();
    const storage = new FakeStorage();
    markAutoCopy(SHORT_ID, storage);

    const { preview, scheduled } = mount(storage);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // コピーを遅らせると離脱で取りこぼす。遅らせるのは表示だけ
    expect(clipboard.writes).toEqual([PUBLIC_URL]);
    expect(preview.dataset['copied']).toBeUndefined();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.delayMs).toBe(500);

    scheduled[0]?.callback();

    expect(preview.dataset['copied']).toBe('true');
  });

  test('自動コピー要求が無ければコピーしない', () => {
    const clipboard = stubClipboard();
    const { scheduled } = mount(new FakeStorage());

    expect(scheduled).toEqual([]);
    expect(clipboard.writes).toEqual([]);
  });
});
