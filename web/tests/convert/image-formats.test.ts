import { afterEach, describe, expect, test } from 'bun:test';

import { FRAME_HEIGHT, FRAME_WIDTH } from '../../src/lib/convert/image';
import { imageUrlsToFrames } from '../../src/lib/convert/imageUrls';

/** JPEG の SOI マーカー。web-capture が png から jpg へ切り替えた時に届くバイト列。 */
const JPEG_MAGIC = [0xff, 0xd8, 0xff] as const;
/** PNG シグネチャ。切り替え前の web-capture が届けるバイト列。 */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47] as const;

interface CanvasCall {
  /** canvas.toBlob に渡された MIME。エンコーダへ渡すフレームの形式。 */
  mime: string;
}

/** 復号と描画の代役。bun には実 canvas が無いので、受け取った Blob を記録する側に徹する。 */
function installBrowserFakes(): { received: Blob[]; canvasCalls: CanvasCall[]; restore: () => void } {
  const original = {
    document: globalThis.document,
    createImageBitmap: globalThis.createImageBitmap,
    fetch: globalThis.fetch,
  };
  const received: Blob[] = [];
  const canvasCalls: CanvasCall[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ fillStyle: '', fillRect: () => {}, drawImage: () => {} }),
    toBlob: (callback: (blob: Blob) => void, mime: string) => {
      canvasCalls.push({ mime });
      callback(new Blob([new Uint8Array([1, 2, 3])]));
    },
  };
  Object.assign(globalThis, {
    document: { createElement: () => canvas },
    createImageBitmap: async (blob: Blob) => {
      received.push(blob);
      return { width: 1920, height: 1080, close: () => {} };
    },
  });
  return {
    received,
    canvasCalls,
    restore: () => Object.assign(globalThis, original),
  };
}

/** URL ごとに、指定した形式のバイト列を返す fetch の代役を置く。 */
function installFetchReturning(magic: readonly number[], mimeType: string): void {
  Object.assign(globalThis, {
    fetch: async (url: string) =>
      new Response(new Blob([new Uint8Array([...magic, ...new TextEncoder().encode(url)])], { type: mimeType }), {
        status: 200,
      }),
  });
}

const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

describe('imageUrlsToFrames の入力形式', () => {
  // web-capture は撮影を速くするため JPEG へ切り替える。取り込み側は形式を判定せず
  // createImageBitmap に任せる設計なので、png / jpg のどちらでも同じ結果になること。
  test.each([
    ['png', PNG_MAGIC, 'image/png'],
    ['jpeg', JPEG_MAGIC, 'image/jpeg'],
  ] as const)('%s のキャプチャを撮影順どおりのフレームに変換する', async (_label, magic, mimeType) => {
    const fakes = installBrowserFakes();
    restores.push(fakes.restore);
    installFetchReturning(magic, mimeType);
    const urls = ['https://cdn.test/0001', 'https://cdn.test/0002', 'https://cdn.test/0003'];

    const frames = await imageUrlsToFrames(urls);

    expect(frames).toHaveLength(urls.length);
    for (const frame of frames) {
      expect(frame.width).toBe(FRAME_WIDTH);
      expect(frame.height).toBe(FRAME_HEIGHT);
    }
    // 取得したバイト列が加工されず復号へ渡る（形式ごとの分岐を持ち込まない）。
    expect(fakes.received.map((blob) => blob.type)).toEqual(urls.map(() => mimeType));
    const decoded = await Promise.all(
      fakes.received.map(async (blob) => new TextDecoder().decode((await blob.arrayBuffer()).slice(magic.length)))
    );
    expect(decoded).toEqual(urls);
  });

  test('入力が JPEG でもエンコーダへ渡すフレームは PNG のまま', async () => {
    const fakes = installBrowserFakes();
    restores.push(fakes.restore);
    installFetchReturning(JPEG_MAGIC, 'image/jpeg');

    await imageUrlsToFrames(['https://cdn.test/0001']);

    // convert/encode.ts は frame-%06d.png で ffmpeg に渡すため、正規化後の形式は固定する。
    expect(fakes.canvasCalls).toEqual([{ mime: 'image/png' }]);
  });
});
