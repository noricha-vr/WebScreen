import { describe, expect, test } from 'bun:test';

import { ConversionError, StageTimeoutError } from '../../src/lib/convert';
import {
  mountConvertPanel,
  putMp4,
  uploadErrorCode,
  uploadErrorEstimatedImages,
  uploadMp4,
} from '../../src/lib/ui/convert-panel';
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
  readonly abortButton = new FakeEventTarget();
  readonly urlInput: { value: string };

  constructor(private readonly fileInput: FakeFileInput, url = '') {
    this.urlInput = { value: url };
  }

  querySelector<T extends Element>(selector: string): T | null {
    const elements: Record<string, unknown> = {
      '[data-file-input]': this.fileInput,
      '[data-url-form]': this.urlForm,
      '[data-url-input]': this.urlInput,
      '[data-abort-button]': this.abortButton,
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

/** 選択後に読めなくなったファイル。事前検査そのものが例外で落ちる状態を再現する。 */
function unreadablePng(): File {
  return {
    name: 'vanished.png',
    type: 'image/png',
    size: 8,
    slice: () => ({
      arrayBuffer: async (): Promise<ArrayBuffer> => {
        throw new Error('NotReadableError');
      },
    }),
  } as unknown as File;
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
  test('URLとファイルは受理されて変換状態へ入った時だけstartを送る', async () => {
    const browser = installBrowserFakes();
    const events: string[] = [];

    try {
      const input = new FakeFileInput();
      const panel = new FakePanel(input, 'https://example.com/articles/latest');
      mountConvertPanel(panel as unknown as HTMLElement, {
        trackAnalytics: (event, kind) => events.push(`${event}:${kind}`),
      });

      panel.urlForm.dispatch('submit');
      await flushPromises();
      expect(events).toEqual(['convert_start:web']);

      panel.abortButton.dispatch('click');
      input.files = [new File(
        [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
        'slide.png',
        { type: 'image/png' }
      )];
      input.dispatch('change');
      await flushPromises();
      expect(events).toEqual(['convert_start:web', 'convert_start:image']);

      panel.abortButton.dispatch('click');
      input.files = [new File(['unsupported'], 'README.txt', { type: 'text/plain' })];
      input.dispatch('change');
      await flushPromises();
      expect(events).toEqual(['convert_start:web', 'convert_start:image']);
    } finally {
      browser.restore();
    }
  });

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

describe('中止', () => {
  test('変換中に中止すると初期表示へ戻り、もう一度変換できる', async () => {
    const browser = installBrowserFakes();

    try {
      const panel = new FakePanel(new FakeFileInput(), 'https://example.com/articles/latest');
      mountConvertPanel(panel as unknown as HTMLElement);

      panel.urlForm.dispatch('submit');
      await flushPromises();
      expect(panel.dataset['phase']).toBe('converting');

      panel.abortButton.dispatch('click');
      await flushPromises();
      expect(panel.dataset['phase']).toBe('idle');

      panel.urlForm.dispatch('submit');
      await flushPromises();
      expect(panel.dataset['phase']).toBe('converting');
    } finally {
      browser.restore();
    }
  });

  test('変換していないときの中止は何も起こさない', () => {
    const browser = installBrowserFakes();

    try {
      const panel = new FakePanel(new FakeFileInput());
      mountConvertPanel(panel as unknown as HTMLElement);

      panel.abortButton.dispatch('click');

      expect(panel.dataset['phase']).toBe('idle');
    } finally {
      browser.restore();
    }
  });
});

describe('入力の事前検査', () => {
  test('検査そのものが失敗したらエラー表示にする', async () => {
    const browser = installBrowserFakes();

    try {
      const input = new FakeFileInput();
      const panel = new FakePanel(input);
      mountConvertPanel(panel as unknown as HTMLElement);

      input.files = [unreadablePng()];
      input.dispatch('change');
      await flushPromises();

      expect(panel.dataset['phase']).toBe('error');
    } finally {
      browser.restore();
    }
  });
});

describe('putMp4', () => {
  test('返らないアップロードは uploadTimeout になる', async () => {
    const originalFetch = globalThis.fetch;
    Object.assign(globalThis, {
      fetch: (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
    });

    try {
      const failure = await putMp4('https://r2.example/put', new Blob(['mp4']), undefined, 5).catch(
        (error: unknown) => error
      );

      expect(failure).toBeInstanceOf(StageTimeoutError);
      expect((failure as StageTimeoutError).code).toBe('uploadTimeout');
    } finally {
      Object.assign(globalThis, { fetch: originalFetch });
    }
  });
});

describe('uploadMp4', () => {
  test('presign の応答を待つ間に中止されたら、予約した動画を取り消してから抜ける', async () => {
    const controller = new AbortController();
    const requests: { url: string; method: string | undefined }[] = [];
    const originalFetch = globalThis.fetch;
    Object.assign(globalThis, {
      fetch: async (url: string, init: RequestInit = {}) => {
        requests.push({ url, method: init.method });
        if (url === '/api/uploads/presign/') {
          // 予約は成立しているが、応答が届くまでの間に利用者が中止した状況。
          controller.abort();
          return new Response(
            JSON.stringify({
              shortId: 'Ab12Cd34Ef56',
              uploadUrl: 'https://upload.test/r2-upload',
              publicUrl: 'https://cdn.test/movies/Ab12Cd34Ef56.mp4',
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(null, { status: 200 });
      },
    });

    try {
      const failure = await uploadMp4(
        new Blob(['mp4']),
        'a.mp4',
        'image',
        () => {},
        0,
        controller.signal
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(requests).toContainEqual({ url: '/api/uploads/abandon/', method: 'POST' });
      // 中止済みなので R2 へは送らない。
      expect(requests.some((request) => request.url === 'https://upload.test/r2-upload')).toBe(false);
    } finally {
      Object.assign(globalThis, { fetch: originalFetch });
    }
  });
});

describe('uploadErrorCode', () => {
  test.each([
    ['PAGE_TOO_LONG', 400, 'pageTooLong'],
    ['CAPTURE_TIMEOUT', 504, 'captureTimeout'],
    ['PAYLOAD_TOO_LARGE', 413, 'tooLarge'],
    ['TOO_MANY_PENDING_UPLOADS', 429, 'failed'],
    ['UNAUTHORIZED', 401, 'sessionExpired'],
  ])('%s を %s へ変換する', (errorCode, status, expected) => {
    expect(uploadErrorCode(new JsonRequestError(status as number, errorCode as string))).toBe(
      expected as ReturnType<typeof uploadErrorCode>
    );
  });

  test('ページが長すぎる時だけ推定画面数を取り出す', () => {
    const tooLong = new JsonRequestError(400, 'PAGE_TOO_LONG', 402);
    const timedOut = new JsonRequestError(504, 'CAPTURE_TIMEOUT', 402);

    expect(uploadErrorEstimatedImages(tooLong)).toBe(402);
    expect(uploadErrorEstimatedImages(timedOut)).toBeNull();
    expect(uploadErrorEstimatedImages(new Error('boom'))).toBeNull();
  });

  test('ブラウザ内のページ数上限は同じ経路で変換する', () => {
    expect(uploadErrorCode(new ConversionError('tooManyPages', 'too many pages'))).toBe('tooManyPages');
  });

  test.each(['wasmLoadTimeout', 'imageFetchTimeout', 'uploadTimeout'])(
    '%s の期限切れは詰まった段のコードのまま表示へ渡す',
    (code) => {
      expect(uploadErrorCode(new StageTimeoutError(code as 'wasmLoadTimeout'))).toBe(
        code as ReturnType<typeof uploadErrorCode>
      );
    }
  );
});
