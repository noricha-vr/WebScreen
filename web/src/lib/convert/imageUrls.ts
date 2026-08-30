import { normalizeImageBlob } from './image';
import { IMAGE_FETCH_TIMEOUT_MS, withStageTimeout } from './timeouts';
import type { FrameSource, VideoFrame } from './types';

type ImageFetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * 撮影画像の同時取得数。
 *
 * 逐次取得だと枚数 × RTT がそのまま待ち時間になり、長いページ（200 枚超）で伸び切る。
 * 一方で取得中の画像はすべてメモリに載るため、この数がピークの主な決定要因になる
 * （同時に生きているのは「取得中の同時取得数 + 引き取って手に持つ 1 枚 + 正規化中の 1 枚」）。
 * ブラウザは同一ホストへの同時接続を 6 本程度に抑えるので、それを超えても
 * ソケット待ちが増えるだけになる。上限をそこへ合わせる。
 */
export const IMAGE_FETCH_CONCURRENCY = 6;

/**
 * 1 枚を期限付きで取得する。
 *
 * 本文の読み取り（blob()）も同じ期限に含めるのは、ヘッダだけ届いて本文が止まる詰まり方があるため。
 */
function fetchImage(
  url: string,
  fetcher: ImageFetcher,
  userSignal: AbortSignal | undefined,
  timeoutMs: number
): Promise<Blob> {
  return withStageTimeout('imageFetchTimeout', timeoutMs, userSignal, async (signal) => {
    const response = await fetcher(url, { signal });
    if (!response.ok) throw new Error(`Could not fetch capture image: ${response.status}`);
    return response.blob();
  });
}

/**
 * URL を数本ずつ並行して取得しつつ、渡された順にちょうど 1 枚ずつ返す。
 *
 * 先読みは同時取得数までに抑える。全 URL を一度に走らせると取得済みの画像が枚数分たまり、
 * 並列化がそのままメモリの増加になるため、呼び出し側が 1 枚引き取るたびに次を 1 本足す。
 *
 * 期限は 1 枚ごとに切り直す（合計ではなく 1 枚あたりの詰まりを見るため）。
 */
export async function* fetchImagesInOrder(
  urls: readonly string[],
  fetcher: ImageFetcher = fetch,
  userSignal?: AbortSignal,
  timeoutMs: number = IMAGE_FETCH_TIMEOUT_MS,
  concurrency: number = IMAGE_FETCH_CONCURRENCY
): AsyncGenerator<Blob> {
  // 途中で抜けたとき（書き出しの失敗・呼び出し側の break）に先読み中の取得を自分で畳む。
  // 利用者のシグナルだけでは止まらず、応答が届くまで通信が残り続ける。
  const abandon = new AbortController();
  const signal = userSignal ? AbortSignal.any([userSignal, abandon.signal]) : abandon.signal;
  const pending: Promise<Blob>[] = [];
  let started = 0;

  const startNext = (): void => {
    if (started >= urls.length) return;
    const running = fetchImage(urls[started]!, fetcher, signal, timeoutMs);
    // 順番待ちの間は await されない。ここで掴んでおかないと、中止・失敗のたびに
    // 待ち行列の後ろ側が unhandled rejection になる。
    void running.catch(() => undefined);
    pending.push(running);
    started += 1;
  };

  try {
    for (let lane = 0; lane < Math.max(1, concurrency); lane += 1) startNext();
    while (pending.length > 0) {
      const image = await pending.shift()!;
      // 1 本空いてから次を足す。引き取る前に足すと同時取得数が 1 本増える。
      startNext();
      yield image;
    }
  } finally {
    abandon.abort();
  }
}

/**
 * CaptureResponse.images の撮影順を保ったまま、1 枚ずつ正規化フレームを供給する。
 *
 * 配列を返さないのは、200 枚規模で「元 Blob の配列 + 正規化済みフレームの配列」を
 * 同時に抱えるとメモリが枚数に比例して増えるため。生成は遅延させ、
 * 消費側（エンコーダ）が引き取った分だけ進む。
 */
export function imageUrlFrameSource(urls: readonly string[], signal?: AbortSignal): FrameSource {
  return { total: urls.length, frames: framesFromImageUrls(urls, signal) };
}

async function* framesFromImageUrls(urls: readonly string[], signal?: AbortSignal): AsyncGenerator<VideoFrame> {
  for await (const image of fetchImagesInOrder(urls, fetch, signal)) {
    // 1 枚ごとに中止を確認する。枚数が多いほど中止から実際に止まるまでが延びるため。
    signal?.throwIfAborted();
    // 正規化は取得と違って並行させない。同時に何枚も PNG が居座ると、
    // 同時取得数だけでメモリの上限を決められなくなる。
    yield await normalizeImageBlob(image, signal);
  }
}
