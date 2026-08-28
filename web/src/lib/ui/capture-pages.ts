import { MAX_CAPTURE_REQUESTS, type CaptureResponse } from '../contracts/api';

/** 1 回分の撮影要求。通信は呼び出し側が持ち、ここは進め方だけを決める。 */
export type CapturePageFetcher = (startIndex: number) => Promise<CaptureResponse>;

export interface CollectCapturesInput {
  fetchPage: CapturePageFetcher;
  /** 取得の進み具合。撮影が終わった枚数と、ページ全体の枚数を渡す。 */
  onProgress?: (collected: number, total: number) => void;
}

/**
 * ページ全体分のスクリーンショットを、必要な回数だけ分けて集める。
 *
 * web-capture は 1 リクエストにつき上限枚数までしか撮れない。短いページは 1 回で
 * 終わる（従来と同じ速度）ため、2 回目以降はページが長いときだけ発生する。
 *
 * 応答が 1 枚も返さない、または総枚数が減るといった前進しない状態は、
 * 無限ループにせずその場で失敗させる（黙って途中までの動画を作らない）。
 */
export async function collectCaptures(input: CollectCapturesInput): Promise<string[]> {
  const images: string[] = [];
  let total = 0;

  for (let attempt = 0; attempt < MAX_CAPTURE_REQUESTS; attempt += 1) {
    const startIndex = images.length;
    const page = await input.fetchPage(startIndex);

    // 総枚数が前回より減るのは、取得の途中でページ自体が変わった証拠。
    // 別世代の画像を繋ぐと動画の連続性が壊れるので続行しない。
    if (attempt > 0 && page.totalImages < total) {
      throw new Error('Capture total shrank between requests');
    }
    // 残り枚数より多く返ってくるのも、開始位置が無視されている等の異常。
    if (page.images.length > Math.max(page.totalImages - startIndex, 0)) {
      throw new Error('Capture returned more images than the remaining count');
    }
    total = page.totalImages;

    if (page.images.length === 0) {
      // 総枚数に達していれば正常な終端。達していないのに空なら前へ進めていない。
      if (images.length >= total) break;
      throw new Error('Capture returned no images before reaching the total');
    }

    images.push(...page.images);
    input.onProgress?.(images.length, total);

    if (images.length >= total) return images;
  }

  if (images.length < total) {
    throw new Error(`Capture did not finish within ${MAX_CAPTURE_REQUESTS} requests`);
  }
  return images;
}
