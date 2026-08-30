import { DEFAULT_CAPTURE_HEIGHT, DEFAULT_CAPTURE_WIDTH } from '../contracts/api';
import { raceAbort } from './timeouts';
import type { ProgressReporter, VideoFrame } from './types';

/** 出力フレームを VRChat 向けの一定解像度へ揃える。 */
export const FRAME_WIDTH = DEFAULT_CAPTURE_WIDTH;
export const FRAME_HEIGHT = DEFAULT_CAPTURE_HEIGHT;

function even(value: number): number {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded - 1;
}

function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context is unavailable');
  return context;
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Image normalization failed'));
    }, 'image/png');
  });
}

/**
 * 画像をレターボックス付きの偶数ピクセル PNG フレームへ正規化する。
 *
 * 復号（createImageBitmap）と PNG 化はシグナルを受け取らないので、待つのをやめる形で中止する。
 * 見捨てた ImageBitmap は後から解決したところで閉じる（GPU 側の領域を持つため放置しない）。
 */
export async function normalizeImageBlob(
  image: Blob,
  signal?: AbortSignal,
  width = FRAME_WIDTH,
  height = FRAME_HEIGHT
): Promise<VideoFrame> {
  const decoding = createImageBitmap(image);
  const bitmap = await raceAbort(decoding, signal).catch((error: unknown) => {
    void decoding.then((late) => late.close()).catch(() => undefined);
    throw error;
  });
  try {
    const targetWidth = even(width);
    const targetHeight = even(height);
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvasContext(canvas);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, targetWidth, targetHeight);

    const scale = Math.min(targetWidth / bitmap.width, targetHeight / bitmap.height);
    const drawWidth = even(bitmap.width * scale);
    const drawHeight = even(bitmap.height * scale);
    context.drawImage(bitmap, (targetWidth - drawWidth) / 2, (targetHeight - drawHeight) / 2, drawWidth, drawHeight);

    const png = await raceAbort(canvasToPng(canvas), signal);
    return {
      data: new Uint8Array(await raceAbort(png.arrayBuffer(), signal)),
      width: targetWidth,
      height: targetHeight,
    };
  } finally {
    bitmap.close();
  }
}

/** 画像ファイル群を選択順どおりのフレーム列へ変換する。 */
export async function imageFilesToFrames(
  files: readonly File[],
  report?: ProgressReporter,
  signal?: AbortSignal
): Promise<VideoFrame[]> {
  const frames: VideoFrame[] = [];
  for (const [index, file] of files.entries()) {
    // 1 枚ごとに中止を確認する。枚数が多いほど中止から実際に止まるまでが延びるため。
    signal?.throwIfAborted();
    frames.push(await normalizeImageBlob(file, signal));
    report?.({ stage: 'preparing', current: index + 1, total: files.length });
  }
  return frames;
}
