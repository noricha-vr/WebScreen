import { afterEach, describe, expect, mock, test } from 'bun:test';

import { encodeFramesToMp4, encodePhaseRatio } from '../../src/lib/convert/encode';
import type { ConversionProgress, FrameSource, VideoFrame } from '../../src/lib/convert/types';

function frame(seed: number): VideoFrame {
  return { data: new Uint8Array([seed]), width: 2, height: 2 };
}

interface FfmpegRecorder {
  /** MEMFS へ書き出されたファイル名。連番が崩れると動画の並びが壊れる。 */
  written: () => readonly string[];
  /** writeFile が呼ばれるたびに走る検査。生存フレーム数の観測に使う。 */
  onWriteFile?: () => void;
}

/** FFmpeg の代役。書き出し順を記録し、実行は常に成功させる。 */
function installFfmpegFake(hooks: { onWriteFile?: () => void } = {}): FfmpegRecorder {
  const written: string[] = [];
  mock.module('@ffmpeg/ffmpeg', () => ({
    FFmpeg: class {
      load = async (): Promise<void> => undefined;
      writeFile = async (name: string): Promise<void> => {
        written.push(name);
        hooks.onWriteFile?.();
      };
      on = (): void => {};
      exec = async (): Promise<number> => 0;
      readFile = async (): Promise<Uint8Array> => new Uint8Array([0, 0, 0, 1]);
      terminate = (): void => {};
    },
  }));
  return { written: () => written };
}

/** core/wasm の取得と Blob URL を差し替える（実 CDN を叩かないため）。 */
function installCoreAssetFakes(): () => void {
  const originals = {
    fetch: globalThis.fetch,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  Object.assign(globalThis, { fetch: async () => new Response(new Uint8Array([1, 2, 3])) });
  URL.createObjectURL = (): string => 'blob:core';
  URL.revokeObjectURL = (): void => {};
  return () => {
    Object.assign(globalThis, { fetch: originals.fetch });
    URL.createObjectURL = originals.createObjectURL;
    URL.revokeObjectURL = originals.revokeObjectURL;
  };
}

const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

describe('encodeFramesToMp4 の供給元入力', () => {
  test('200 枚を流しても、同時に抱えるフレームは 1 枚に収まる', async () => {
    restores.push(installCoreAssetFakes());
    const total = 200;
    let produced = 0;
    let written = 0;
    const liveHighWaterMark: number[] = [];
    const recorder = installFfmpegFake({
      onWriteFile: () => {
        written += 1;
        // 書き出し中に生成済みで未書き出しのフレーム数。配列で抱えるとここが枚数まで伸びる。
        liveHighWaterMark.push(produced - written);
      },
    });

    async function* lazyFrames(): AsyncGenerator<VideoFrame> {
      for (let index = 0; index < total; index += 1) {
        produced += 1;
        yield frame(index);
      }
    }
    const source: FrameSource = { total, frames: lazyFrames() };

    const mp4 = await encodeFramesToMp4(source);

    expect(mp4.type).toBe('video/mp4');
    expect(recorder.written()).toHaveLength(total);
    // 書き出した瞬間に生成済み - 書き出し済み = 0（引き取った 1 枚を書き終えた直後）。
    expect(Math.max(...liveHighWaterMark)).toBe(0);
    expect(produced).toBe(total);
  });

  test('供給された順にそのまま連番で書き出す', async () => {
    restores.push(installCoreAssetFakes());
    const recorder = installFfmpegFake();

    async function* lazyFrames(): AsyncGenerator<VideoFrame> {
      yield frame(0);
      yield frame(1);
      yield frame(2);
    }

    await encodeFramesToMp4({ total: 3, frames: lazyFrames() });

    expect(recorder.written()).toEqual(['frame-000000.png', 'frame-000001.png', 'frame-000002.png']);
  });

  test('書き出しの進捗は総数に対して単調に進む（帯域は 0.12→0.4 のまま）', async () => {
    restores.push(installCoreAssetFakes());
    installFfmpegFake();
    const writingRatios: number[] = [];
    const report = (progress: ConversionProgress): void => {
      // 実行段階の報告と混ざらないよう、書き出し帯域に収まるものだけ拾う。
      const ratio = progress.ratio ?? 0;
      if (ratio >= encodePhaseRatio('writing', 0, 4) && ratio <= encodePhaseRatio('writing', 4, 4)) {
        writingRatios.push(ratio);
      }
    };

    async function* lazyFrames(): AsyncGenerator<VideoFrame> {
      for (let index = 0; index < 4; index += 1) yield frame(index);
    }

    await encodeFramesToMp4({ total: 4, frames: lazyFrames() }, report);

    expect(writingRatios).toEqual([...writingRatios].sort((a, b) => a - b));
    expect(writingRatios.at(-1)).toBeCloseTo(0.4);
  });

  test('供給されたフレームが総数に届かなければ、短い動画を作らずに失敗する', async () => {
    restores.push(installCoreAssetFakes());
    installFfmpegFake();

    async function* tooFewFrames(): AsyncGenerator<VideoFrame> {
      yield frame(0);
    }

    // 連番が途切れると FFmpeg は途中までを繋いだ動画を黙って作るため、ここで止める。
    expect(await encodeFramesToMp4({ total: 3, frames: tooFewFrames() }).catch((e: unknown) => e)).toBeInstanceOf(
      Error
    );
  });

  test('配列を渡す従来の経路（PDF・ローカル画像）は同じ結果になる', async () => {
    restores.push(installCoreAssetFakes());
    const recorder = installFfmpegFake();

    const mp4 = await encodeFramesToMp4([frame(0), frame(1)]);

    expect(mp4.type).toBe('video/mp4');
    expect(recorder.written()).toEqual(['frame-000000.png', 'frame-000001.png']);
  });

  test('フレームが 1 枚も無ければエンコードを始めない', async () => {
    restores.push(installCoreAssetFakes());
    installFfmpegFake();

    expect(await encodeFramesToMp4([]).catch((e: unknown) => e)).toBeInstanceOf(Error);
  });
});
