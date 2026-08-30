import { afterEach, describe, expect, mock, test } from 'bun:test';

import { imageFilesToFrames } from '../../src/lib/convert/image';
import { pdfToFrames } from '../../src/lib/convert/pdf';

/** canvas を使う変換のために、描画まわりの最小限の代役を置く。 */
function installCanvasFakes(): () => void {
  const original = { document: globalThis.document, createImageBitmap: globalThis.createImageBitmap };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: '', fillRect: () => {}, drawImage: () => {} }),
    toBlob: (callback: (blob: Blob) => void) => callback(new Blob([new Uint8Array([1, 2, 3])])),
  };
  Object.assign(globalThis, { document: { createElement: () => canvas } });
  return () => Object.assign(globalThis, original);
}

const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

describe('imageFilesToFrames', () => {
  test('中止したら残りの画像を処理しない', async () => {
    restores.push(installCanvasFakes());
    const controller = new AbortController();
    let started = 0;
    Object.assign(globalThis, {
      createImageBitmap: async () => {
        started += 1;
        // 1 枚目の処理中に中止された状況。
        controller.abort();
        return { width: 2, height: 2, close: () => {} };
      },
    });

    const failure = await imageFilesToFrames(
      [new File(['a'], 'a.png'), new File(['b'], 'b.png'), new File(['c'], 'c.png')],
      undefined,
      controller.signal
    ).catch((error: unknown) => error);

    expect(started).toBe(1);
    expect(failure).toBeInstanceOf(Error);
  });
});

describe('pdfToFrames', () => {
  test('中止したら残りのページを描画せず、進行中の描画も打ち切る', async () => {
    restores.push(installCanvasFakes());
    const controller = new AbortController();
    let renders = 0;
    let cancels = 0;
    let terminated = 0;

    const page = {
      getViewport: () => ({ width: 100, height: 100 }),
      render: () => {
        renders += 1;
        // 1 ページ目の描画中に中止された状況。
        controller.abort();
        return {
          promise: Promise.resolve(),
          cancel: () => {
            cancels += 1;
          },
        };
      },
    };
    const workerPortHolder = { workerPort: null as unknown };
    mock.module('pdfjs-dist', () => ({
      GlobalWorkerOptions: workerPortHolder,
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 3,
          getPage: async () => page,
          destroy: async () => {},
        }),
      }),
    }));
    Object.assign(globalThis, {
      Worker: class {
        terminate(): void {
          terminated += 1;
        }
      },
    });

    const failure = await pdfToFrames(new File(['pdf'], 'a.pdf'), undefined, controller.signal).catch(
      (error: unknown) => error
    );

    expect(renders).toBe(1);
    expect(cancels).toBe(1);
    expect(failure).toBeInstanceOf(Error);
    // 自前の worker は pdfjs が畳んでくれないので、中止でも必ず終了させる。
    expect(terminated).toBe(1);
    expect(workerPortHolder.workerPort).toBeNull();
  });
});
