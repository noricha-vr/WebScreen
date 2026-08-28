import { describe, expect, test } from 'bun:test';

import { ConversionError } from '../../src/lib/convert';
import { mountConvertPanel, uploadErrorCode } from '../../src/lib/ui/convert-panel';
import { JsonRequestError } from '../../src/lib/ui/request-json';

type Listener = (event: Event) => void;

class FakeEventTarget {
  readonly listeners = new Map<string, Listener>();

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === 'function') this.listeners.set(type, listener);
  }

  dispatch(type: string): void {
    this.listeners.get(type)?.(new Event(type));
  }
}

class FakeFileInput extends FakeEventTarget {
  files: File[] = [];
  value = '';
}

class FakePanel {
  readonly dataset: DOMStringMap = {};
  readonly sourceName = { textContent: '' };
  readonly urlForm = new FakeEventTarget();
  readonly urlInput: { value: string };

  constructor(private readonly fileInput: FakeFileInput, url = '') {
    this.urlInput = { value: url };
  }

  querySelector<T extends Element>(selector: string): T | null {
    const elements: Record<string, unknown> = {
      '[data-file-input]': this.fileInput,
      '[data-url-form]': this.urlForm,
      '[data-url-input]': this.urlInput,
    };
    return (elements[selector] ?? null) as T | null;
  }

  querySelectorAll<T extends Element>(selector: string): T[] {
    return (selector === '[data-source-name]' ? [this.sourceName] : []) as T[];
  }
}

function controlledPng(
  bytes = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
): { file: File; release: () => void } {
  const header = new Uint8Array(bytes);
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

function installBrowserFakes(): { conversionStarts: () => number; restore: () => void } {
  const originalWindow = globalThis.window;
  const originalCreateImageBitmap = globalThis.createImageBitmap;
  const originalFetch = globalThis.fetch;
  let conversionStarts = 0;
  Object.assign(globalThis, {
    window: {
      addEventListener: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
    },
    createImageBitmap: () => {
      conversionStarts += 1;
      return new Promise<ImageBitmap>(() => {});
    },
    fetch: () => new Promise<Response>(() => {}),
  });
  return {
    conversionStarts: () => conversionStarts,
    restore: () => {
      Object.assign(globalThis, {
        window: originalWindow,
        createImageBitmap: originalCreateImageBitmap,
        fetch: originalFetch,
      });
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('mountConvertPanel', () => {
  test('遅い1件目のpreflight完了は後続ファイルの状態と変換開始を上書きしない', async () => {
    const browser = installBrowserFakes();

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
      expect(browser.conversionStarts()).toBe(0);
    } finally {
      browser.restore();
    }
  });

  test('遅いファイルpreflight完了は後続URLの状態と変換開始を上書きしない', async () => {
    const browser = installBrowserFakes();
    const url = 'https://example.com/articles/latest';

    try {
      const input = new FakeFileInput();
      const panel = new FakePanel(input, url);
      const slowInvalid = controlledPng([0x00]);
      mountConvertPanel(panel as unknown as HTMLElement);

      input.files = [slowInvalid.file];
      input.dispatch('change');
      panel.urlForm.dispatch('submit');
      await flushPromises();
      expect(panel.dataset['phase']).toBe('converting');
      expect(panel.sourceName.textContent).toBe(url);

      slowInvalid.release();
      await flushPromises();

      expect(panel.dataset['phase']).toBe('converting');
      expect(panel.sourceName.textContent).toBe(url);
      expect(browser.conversionStarts()).toBe(0);
    } finally {
      browser.restore();
    }
  });
});

describe('uploadErrorCode', () => {
  test.each([
    ['PAGE_TOO_LONG', 400, 'pageTooLong'],
    ['CAPTURE_TIMEOUT', 504, 'captureTimeout'],
    ['PAYLOAD_TOO_LARGE', 413, 'tooLarge'],
    ['UNAUTHORIZED', 401, 'sessionExpired'],
  ])('%s を %s へ変換する', (errorCode, status, expected) => {
    expect(uploadErrorCode(new JsonRequestError(status as number, errorCode as string))).toBe(
      expected as ReturnType<typeof uploadErrorCode>
    );
  });

  test('ブラウザ内のページ数上限は同じ経路で変換する', () => {
    expect(uploadErrorCode(new ConversionError('tooManyPages', 'too many pages'))).toBe('tooManyPages');
  });
});
