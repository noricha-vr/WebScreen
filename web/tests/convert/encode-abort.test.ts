import { afterEach, describe, expect, mock, test } from 'bun:test';

import { encodeFramesToMp4 } from '../../src/lib/convert/encode';
import { StageTimeoutError } from '../../src/lib/convert/timeouts';

const FRAMES = [{ data: new Uint8Array([1, 2, 3]), width: 2, height: 2 }];

interface FfmpegFakeOptions {
  /** load() が返らない（core は取れたのに worker が立ち上がらない状況）。 */
  loadHangs?: boolean;
  /** writeFile() が返らない（フレーム書き出しで詰まる状況）。 */
  writeHangs?: boolean;
  /** writeFile() に入った瞬間に呼ぶ。中止のタイミングを確定させるために使う。 */
  onWriteFile?: () => void;
}

/**
 * FFmpeg の代役。terminate() が保留中の待ちを reject するのは実物と同じ挙動で、
 * 「シグナルを受け取れない処理を worker ごと畳んで止める」という設計の前提そのもの。
 */
function installFfmpegFake(options: FfmpegFakeOptions = {}): () => number {
  let terminations = 0;
  let terminated = false;
  const pending = new Set<(reason: unknown) => void>();
  // 実物は worker へ送った時点で待ちが登録され、terminate() で一括 reject される。
  // 畳んだ後の呼び出しも待たずに落ちるので、代役も同じ順序にしておく。
  const hang = <T>(): Promise<T> =>
    new Promise<T>((_resolve, reject) => {
      if (terminated) {
        reject(new Error('FFmpeg terminated'));
        return;
      }
      pending.add(reject);
    });

  mock.module('@ffmpeg/ffmpeg', () => ({
    FFmpeg: class {
      load = async (): Promise<void> => (options.loadHangs ? hang<void>() : undefined);
      writeFile = async (): Promise<void> => {
        if (!options.writeHangs) {
          options.onWriteFile?.();
          return;
        }
        // 待ちを登録してから中止させる（実物も送信後に中止が届く）。
        const waiting = hang<void>();
        options.onWriteFile?.();
        return waiting;
      };
      on = (): void => {};
      exec = async (): Promise<number> => 0;
      readFile = async (): Promise<Uint8Array> => new Uint8Array([0, 0, 0, 1]);
      terminate = (): void => {
        terminations += 1;
        terminated = true;
        for (const reject of pending) reject(new Error('FFmpeg terminated'));
        pending.clear();
      };
    },
  }));

  return () => terminations;
}

/** core/wasm の取得と Blob URL を差し替え、解放された URL を数える。 */
function installCoreAssetFakes(options: { failWasm?: boolean } = {}): {
  revoked: () => readonly string[];
  restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  let issued = 0;

  Object.assign(globalThis, {
    fetch: async (url: string) => {
      if (options.failWasm && url.endsWith('.wasm')) throw new Error('core asset unavailable');
      return new Response(new Uint8Array([1, 2, 3]));
    },
  });
  URL.createObjectURL = (): string => `blob:core-${(issued += 1)}`;
  URL.revokeObjectURL = (url: string): void => {
    revoked.push(url);
  };

  return {
    revoked: () => revoked,
    restore: () => {
      Object.assign(globalThis, { fetch: originalFetch });
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
}

/** 期限の時計だけ縮める。製品コードの定数（60 秒）はそのままに、待たずに期限切れを観測する。 */
function installFastTimeouts(afterMs = 5): () => void {
  const original = AbortSignal.timeout;
  AbortSignal.timeout = (): AbortSignal => original.call(AbortSignal, afterMs);
  return () => {
    AbortSignal.timeout = original;
  };
}

const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

async function caught(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
    return null;
  } catch (error) {
    return error;
  }
}

describe('encodeFramesToMp4 の中止', () => {
  test('変換エンジンの起動が返らなくても、中止したら worker を畳んで Blob URL を解放する', async () => {
    const assets = installCoreAssetFakes();
    restores.push(assets.restore);
    const terminations = installFfmpegFake({ loadHangs: true });
    const controller = new AbortController();

    const running = encodeFramesToMp4(FRAMES, undefined, controller.signal);
    await Promise.resolve();
    controller.abort();

    expect(await caught(running)).not.toBeNull();
    expect(terminations()).toBeGreaterThan(0);
    // core と wasm の 2 本。解放しないと変換のたびに数十 MB 分が残る。
    expect(assets.revoked()).toHaveLength(2);
  });

  test('フレーム書き出し中に中止しても、worker を畳んで待ちが解ける', async () => {
    const assets = installCoreAssetFakes();
    restores.push(assets.restore);
    const controller = new AbortController();
    const terminations = installFfmpegFake({
      writeHangs: true,
      onWriteFile: () => controller.abort(),
    });

    const failure = await caught(encodeFramesToMp4(FRAMES, undefined, controller.signal));

    expect(failure).not.toBeNull();
    expect(terminations()).toBeGreaterThan(0);
  });
});

describe('encodeFramesToMp4 の期限切れ', () => {
  test('変換エンジンの起動が返らないまま期限を過ぎたら wasmLoadTimeout になる', async () => {
    restores.push(installFastTimeouts());
    const assets = installCoreAssetFakes();
    restores.push(assets.restore);
    installFfmpegFake({ loadHangs: true });

    const failure = await caught(encodeFramesToMp4(FRAMES));

    expect(failure).toBeInstanceOf(StageTimeoutError);
    expect((failure as StageTimeoutError).code).toBe('wasmLoadTimeout');
    expect(assets.revoked()).toHaveLength(2);
  });

  test('core と wasm の片方だけ取れた場合も、成功した側の Blob URL を解放する', async () => {
    const assets = installCoreAssetFakes({ failWasm: true });
    restores.push(assets.restore);
    installFfmpegFake();

    expect(await caught(encodeFramesToMp4(FRAMES))).not.toBeNull();
    expect(assets.revoked()).toHaveLength(1);
  });
});
