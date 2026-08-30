import { afterEach, describe, expect, test } from 'bun:test';

import {
  fetchImagesInOrder,
  IMAGE_FETCH_CONCURRENCY,
  imageUrlFrameSource,
} from '../../src/lib/convert/imageUrls';
import { StageTimeoutError } from '../../src/lib/convert/timeouts';

/** 保留中のマイクロタスクを流し切る。先読みが何本走ったかを観測するために使う。 */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

async function caught(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
    return null;
  } catch (error) {
    return error;
  }
}

function urls(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `https://images.example/${index}.png`);
}

/** 中止されるまで返らない通信。R2 が詰まった状態を再現する。 */
function neverResolvingFetch(): (url: string, init: RequestInit) => Promise<Response> {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (!signal) return;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

/** 取得を任意のタイミングで解けるようにした代役。走っているリクエストの signal も見られる。 */
function gatedFetch(): {
  fetcher: (url: string, init: RequestInit) => Promise<Response>;
  started: () => number;
  signals: () => readonly AbortSignal[];
  releaseOldest: () => void;
} {
  const gates: (() => void)[] = [];
  const signals: AbortSignal[] = [];
  let started = 0;

  return {
    fetcher: (url, init) => {
      started += 1;
      if (init.signal) signals.push(init.signal);
      return new Promise<Response>((resolve, reject) => {
        gates.push(() => resolve(new Response(new Blob([url]))));
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    },
    started: () => started,
    signals: () => signals,
    releaseOldest: () => gates.shift()?.(),
  };
}

const restores: (() => void)[] = [];

afterEach(() => {
  while (restores.length > 0) restores.pop()?.();
});

describe('fetchImagesInOrder', () => {
  test('取得の完了順が入れ替わっても、渡された順のまま 1 枚ずつ返す', async () => {
    const requested: string[] = [];
    const delays: Readonly<Record<string, number>> = { first: 20, second: 10, third: 0 };
    const fetcher = async (url: string): Promise<Response> => {
      requested.push(url);
      // 撮影順とは逆の順で完了させる。並列化で並び替わらないことを見る。
      await new Promise((resolve) => setTimeout(resolve, delays[url] ?? 0));
      return new Response(new Blob([url]));
    };

    const images = await collect(fetchImagesInOrder(['first', 'second', 'third'], fetcher));

    // 短いページで取得の本数が増えない（1 URL あたり 1 回）。
    expect(requested).toEqual(['first', 'second', 'third']);
    expect(await Promise.all(images.map((image) => image.text()))).toEqual(['first', 'second', 'third']);
  });

  test('先読みは同時取得数までで、1 枚引き取るごとに次を 1 本足す', async () => {
    const target = urls(20);
    const concurrency = 4;
    const gate = gatedFetch();
    const images = fetchImagesInOrder(target, gate.fetcher, undefined, 10_000, concurrency)[
      Symbol.asyncIterator
    ]();

    let step = images.next();
    await settle();
    // 全 URL を一度に走らせない。ここが破れると取得済み画像が枚数分たまる。
    expect(gate.started()).toBe(concurrency);

    let consumed = 0;
    for (;;) {
      gate.releaseOldest();
      const result = await step;
      if (result.done === true) break;
      consumed += 1;
      expect(gate.started()).toBeLessThanOrEqual(consumed + concurrency);
      step = images.next();
      await settle();
    }

    expect(consumed).toBe(target.length);
    expect(gate.started()).toBe(target.length);
  });

  test('取得の途中で中止すると、走っているリクエストが全部止まる', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    restores.push(() => process.off('unhandledRejection', onUnhandled));

    const controller = new AbortController();
    const gate = gatedFetch();
    const concurrency = 3;
    const running = collect(fetchImagesInOrder(urls(10), gate.fetcher, controller.signal, 10_000, concurrency));
    await settle();
    expect(gate.started()).toBe(concurrency);

    controller.abort();

    expect(await caught(running)).toBeInstanceOf(Error);
    expect(gate.signals().every((signal) => signal.aborted)).toBe(true);
    // 順番待ちの取得は await されないまま落ちる。掴んでおかないと unhandled rejection になる。
    await settle();
    expect(unhandled).toEqual([]);
  });

  test('引き取りを途中でやめたら、先読み中の取得も畳む', async () => {
    const gate = gatedFetch();
    const concurrency = 3;
    // 1 枚だけ受け取って離脱する（書き出しが失敗して for-await を抜ける状況）。
    const iteration = (async () => {
      for await (const _image of fetchImagesInOrder(urls(10), gate.fetcher, undefined, 10_000, concurrency)) {
        break;
      }
    })();

    await settle();
    expect(gate.started()).toBe(concurrency);
    gate.releaseOldest();
    await iteration;
    await settle();

    // 呼び出し側のシグナルが無くても、走らせた取得は自分で止める。
    expect(gate.signals().filter((signal) => !signal.aborted)).toHaveLength(0);
  });

  test('返らない画像取得は imageFetchTimeout になる', async () => {
    const failure = await caught(
      collect(fetchImagesInOrder(['https://images.example/a.png'], neverResolvingFetch(), undefined, 5))
    );

    expect(failure).toBeInstanceOf(StageTimeoutError);
    expect((failure as StageTimeoutError).code).toBe('imageFetchTimeout');
  });

  test('期限は 1 枚ごとに切り直す（合計が上限を超えても落ちない）', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      await new Promise((resolve) => setTimeout(resolve, 6));
      return new Response(url);
    };

    // 同時取得数を 1 にして、期限が合計ではなく 1 枚ごとであることだけを見る。
    const images = await collect(fetchImagesInOrder(['a', 'b', 'c'], fetcher, undefined, 20, 1));

    expect(images).toHaveLength(3);
  });
});

describe('imageUrlFrameSource', () => {
  test('撮影順のまま 1 枚ずつフレームを供給し、取得済み画像を枚数分ためない', async () => {
    const decoded: string[] = [];
    const originals = { fetch: globalThis.fetch, createImageBitmap: globalThis.createImageBitmap };
    let fetched = 0;
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: '', fillRect: () => {}, drawImage: () => {} }),
      toBlob: (callback: (blob: Blob) => void) => callback(new Blob([new Uint8Array([1, 2, 3])])),
    };
    Object.assign(globalThis, {
      document: { createElement: () => canvas },
      fetch: async (url: string) => {
        fetched += 1;
        return new Response(new Blob([url]));
      },
      createImageBitmap: async (image: Blob) => {
        decoded.push(await image.text());
        return { width: 2, height: 2, close: () => {} };
      },
    });
    restores.push(() => Object.assign(globalThis, originals));

    const target = urls(20);
    const source = imageUrlFrameSource(target);
    expect(source.total).toBe(target.length);

    let produced = 0;
    for await (const frame of source.frames) {
      produced += 1;
      expect(frame.data.length).toBeGreaterThan(0);
      // 取得済みで未消費の画像は同時取得数の範囲に収まる（引き取った 1 枚を足しても上限内）。
      expect(fetched - produced).toBeLessThanOrEqual(IMAGE_FETCH_CONCURRENCY);
    }

    expect(produced).toBe(target.length);
    expect(decoded).toEqual(target);
  });
});
