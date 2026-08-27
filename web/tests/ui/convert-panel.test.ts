import { describe, expect, test } from 'bun:test';

import { mountConvertPanel } from '../../src/lib/ui/convert-panel';

type Listener = (event: Event) => void;

class FakeFileInput {
  files: File[] = [];
  value = '';
  readonly listeners = new Map<string, Listener>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === 'function') this.listeners.set(type, listener);
  }

  dispatch(type: string): void {
    this.listeners.get(type)?.(new Event(type));
  }
}

class FakePanel {
  readonly dataset: DOMStringMap = {};

  constructor(private readonly fileInput: FakeFileInput) {}

  querySelector<T extends Element>(selector: string): T | null {
    return (selector === '[data-file-input]' ? this.fileInput : null) as T | null;
  }

  querySelectorAll<T extends Element>(): T[] {
    return [];
  }
}

function controlledPng(): { file: File; release: () => void } {
  const header = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let release = (): void => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const file = {
    name: 'slow.png',
    type: 'image/png',
    size: header.byteLength,
    slice: () => ({
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        await ready;
        return header.buffer;
      },
    }),
  } as unknown as File;
  return { file, release };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('mountConvertPanel', () => {
  test('遅い1件目のpreflight完了は後続ファイルの状態と変換開始を上書きしない', async () => {
    const originalWindow = globalThis.window;
    const originalCreateImageBitmap = globalThis.createImageBitmap;
    let conversionStarts = 0;
    Object.assign(globalThis, {
      window: { addEventListener: () => {} },
      createImageBitmap: () => {
        conversionStarts += 1;
        return new Promise<ImageBitmap>(() => {});
      },
    });

    try {
      const input = new FakeFileInput();
      const panel = new FakePanel(input);
      const slow = controlledPng();
      mountConvertPanel(panel as unknown as HTMLElement);

      input.files = [slow.file];
      input.dispatch('change');
      input.files = [new File(['unsupported'], 'README.txt', { type: 'text/plain' })];
      input.dispatch('change');
      await flushPromises();
      expect(panel.dataset['phase']).toBe('error');

      slow.release();
      await flushPromises();

      expect(panel.dataset['phase']).toBe('error');
      expect(conversionStarts).toBe(0);
    } finally {
      Object.assign(globalThis, {
        window: originalWindow,
        createImageBitmap: originalCreateImageBitmap,
      });
    }
  });
});
