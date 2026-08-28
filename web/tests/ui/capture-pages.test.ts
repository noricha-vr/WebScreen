import { describe, expect, it } from 'bun:test';

import { MAX_CAPTURE_REQUESTS, type CaptureResponse } from '../../src/lib/contracts/api';
import { collectCaptures } from '../../src/lib/ui/capture-pages';

/** 上限枚数ごとに切り出して返す、web-capture の応答の模型。 */
function pagedSource(total: number, perRequest: number) {
  const calls: number[] = [];
  const fetchPage = async (startIndex: number): Promise<CaptureResponse> => {
    calls.push(startIndex);
    const images = Array.from(
      { length: Math.min(perRequest, Math.max(total - startIndex, 0)) },
      (_unused, offset) => `https://cdn.test/captures/${startIndex + offset + 1}.png`
    );
    return { images, totalImages: total };
  };
  return { calls, fetchPage };
}

describe('collectCaptures', () => {
  it('総枚数に収まるページは 1 回の要求で終わる', async () => {
    // 短いページを従来どおりの速度で通すことが要件
    const source = pagedSource(30, 100);

    const images = await collectCaptures({ fetchPage: source.fetchPage });

    expect(images).toHaveLength(30);
    expect(source.calls).toEqual([0]);
  });

  it('上限を超える長いページは続きを取りに行く', async () => {
    const source = pagedSource(213, 100);

    const images = await collectCaptures({ fetchPage: source.fetchPage });

    expect(images).toHaveLength(213);
    expect(source.calls).toEqual([0, 100, 200]);
  });

  it('撮影順を保ったまま連結する', async () => {
    const source = pagedSource(150, 100);

    const images = await collectCaptures({ fetchPage: source.fetchPage });

    // 順序が狂うとスクロール動画が破綻する
    expect(images[0]).toContain('/1.png');
    expect(images[99]).toContain('/100.png');
    expect(images[100]).toContain('/101.png');
    expect(images[149]).toContain('/150.png');
  });

  it('進捗を集まった枚数と総枚数で通知する', async () => {
    const source = pagedSource(150, 100);
    const progress: [number, number][] = [];

    await collectCaptures({
      fetchPage: source.fetchPage,
      onProgress: (collected, total) => progress.push([collected, total]),
    });

    expect(progress).toEqual([
      [100, 150],
      [150, 150],
    ]);
  });

  it('前進しない応答を無限に繰り返さない', async () => {
    // 総枚数に届いていないのに空を返す = 進めていない
    const fetchPage = async (): Promise<CaptureResponse> => ({ images: [], totalImages: 213 });

    expect(collectCaptures({ fetchPage })).rejects.toThrow();
  });

  it('要求回数の上限を超えたら失敗させる', async () => {
    // 1 回あたり 1 枚しか返さないサーバーで、途中までの動画を黙って作らない
    const source = pagedSource(1_000, 1);

    expect(collectCaptures({ fetchPage: source.fetchPage })).rejects.toThrow();
    expect(source.calls.length).toBeLessThanOrEqual(MAX_CAPTURE_REQUESTS);
  });

  it('総枚数が減る応答は矛盾として扱う', async () => {
    // 取得の途中でページ自体が変わった証拠。別世代の画像を繋ぐと動画が破綻する
    let call = 0;
    const fetchPage = async (): Promise<CaptureResponse> => {
      call += 1;
      return call === 1
        ? { images: ['https://cdn.test/captures/1.png'], totalImages: 213 }
        : { images: ['https://cdn.test/other/2.png'], totalImages: 150 };
    };

    expect(collectCaptures({ fetchPage })).rejects.toThrow();
  });

  it('残り枚数より多く返す応答を拒否する', async () => {
    // 開始位置が無視されて先頭から返ってきている等の異常
    const fetchPage = async (): Promise<CaptureResponse> => ({
      images: ['a', 'b', 'c'],
      totalImages: 2,
    });

    expect(collectCaptures({ fetchPage })).rejects.toThrow();
  });
});
