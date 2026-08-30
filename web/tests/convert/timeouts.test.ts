import { describe, expect, test } from 'bun:test';

import { fetchImagesInOrder } from '../../src/lib/convert/imageUrls';
import { StageTimeoutError, withStageTimeout } from '../../src/lib/convert/timeouts';

/** 中止されるまで返らない通信。CDN や R2 が詰まった状態を再現する。 */
function neverResolvingFetch(): (url: string, init: RequestInit) => Promise<Response> {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (!signal) return;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

async function caught(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
    return null;
  } catch (error) {
    return error;
  }
}

describe('withStageTimeout', () => {
  test('返らない通信は段の分かる期限切れとして失敗する', async () => {
    const error = await caught(
      withStageTimeout('wasmLoadTimeout', 5, undefined, (signal) => neverResolvingFetch()('https://cdn', { signal }))
    );

    expect(error).toBeInstanceOf(StageTimeoutError);
    expect((error as StageTimeoutError).code).toBe('wasmLoadTimeout');
  });

  test('利用者の中止は期限切れに化けない', async () => {
    const user = new AbortController();
    const running = withStageTimeout('uploadTimeout', 60_000, user.signal, (signal) =>
      neverResolvingFetch()('https://r2', { signal })
    );
    user.abort();

    expect(await caught(running)).not.toBeInstanceOf(StageTimeoutError);
  });

  test('期限内に終われば結果をそのまま返す', async () => {
    expect(await withStageTimeout('imageFetchTimeout', 1_000, undefined, async () => 'done')).toBe('done');
  });
});

describe('fetchImagesInOrder', () => {
  test('返らない画像取得は imageFetchTimeout になる', async () => {
    const error = await caught(
      fetchImagesInOrder(['https://example.com/a.png'], neverResolvingFetch(), undefined, 5)
    );

    expect(error).toBeInstanceOf(StageTimeoutError);
    expect((error as StageTimeoutError).code).toBe('imageFetchTimeout');
  });

  test('期限は 1 枚ごとに切り直す（合計が上限を超えても落ちない）', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      await new Promise((resolve) => setTimeout(resolve, 6));
      return new Response(url);
    };

    const images = await fetchImagesInOrder(['a', 'b', 'c'], fetcher, undefined, 20);

    expect(images).toHaveLength(3);
  });
});
