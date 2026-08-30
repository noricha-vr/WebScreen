import { normalizeImageBlob } from './image';
import { IMAGE_FETCH_TIMEOUT_MS, withStageTimeout } from './timeouts';
import type { ProgressReporter, VideoFrame } from './types';

type ImageFetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * URL を渡された順に取得し、取得完了順で並べ替わらないようにする。
 *
 * 期限は 1 枚ごとに切り直す。本文の読み取り（blob()）も同じ期限に含めるのは、
 * ヘッダだけ届いて本文が止まる詰まり方があるため。
 */
export async function fetchImagesInOrder(
  urls: readonly string[],
  fetcher: ImageFetcher = fetch,
  userSignal?: AbortSignal,
  timeoutMs: number = IMAGE_FETCH_TIMEOUT_MS
): Promise<Blob[]> {
  const images: Blob[] = [];
  for (const url of urls) {
    images.push(
      await withStageTimeout('imageFetchTimeout', timeoutMs, userSignal, async (signal) => {
        const response = await fetcher(url, { signal });
        if (!response.ok) throw new Error(`Could not fetch capture image: ${response.status}`);
        return response.blob();
      })
    );
  }
  return images;
}

/** CaptureResponse.images の撮影順を保ったまま正規化フレームへ変換する。 */
export async function imageUrlsToFrames(
  urls: readonly string[],
  report?: ProgressReporter,
  signal?: AbortSignal
): Promise<VideoFrame[]> {
  // 取得（枚数分の fetch）は正規化より前に時間を使うため、段階の切り替わりを先に知らせる。
  // 撮影完了の表示のまま数十秒止まって見えるのを避ける。
  report?.({ stage: 'preparing', current: 0, total: urls.length });
  const images = await fetchImagesInOrder(urls, fetch, signal);
  const frames: VideoFrame[] = [];
  for (const [index, image] of images.entries()) {
    // 正規化は 1 枚ずつ CPU を使うだけなので、中止はここで打ち切る。
    signal?.throwIfAborted();
    frames.push(await normalizeImageBlob(image, signal));
    report?.({ stage: 'preparing', current: index + 1, total: images.length });
  }
  return frames;
}
