import { normalizeImageBlob } from './image';
import type { ProgressReporter, VideoFrame } from './types';

type ImageFetcher = (url: string) => Promise<Response>;

/** URL を渡された順に取得し、取得完了順で並べ替わらないようにする。 */
export async function fetchImagesInOrder(
  urls: readonly string[],
  fetcher: ImageFetcher = fetch
): Promise<Blob[]> {
  const images: Blob[] = [];
  for (const url of urls) {
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`Could not fetch capture image: ${response.status}`);
    images.push(await response.blob());
  }
  return images;
}

/** CaptureResponse.images の撮影順を保ったまま正規化フレームへ変換する。 */
export async function imageUrlsToFrames(urls: readonly string[], report?: ProgressReporter): Promise<VideoFrame[]> {
  // 取得（枚数分の fetch）は正規化より前に時間を使うため、段階の切り替わりを先に知らせる。
  // 撮影完了の表示のまま数十秒止まって見えるのを避ける。
  report?.({ stage: 'preparing', current: 0, total: urls.length });
  const images = await fetchImagesInOrder(urls);
  const frames: VideoFrame[] = [];
  for (const [index, image] of images.entries()) {
    frames.push(await normalizeImageBlob(image));
    report?.({ stage: 'preparing', current: index + 1, total: images.length });
  }
  return frames;
}
