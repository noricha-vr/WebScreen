import { DEFAULT_CAPTURE_HEIGHT, DEFAULT_CAPTURE_WIDTH } from '../contracts/api';
import { onAbort } from './timeouts';
import type { ProgressReporter, VideoFrame } from './types';
import { ConversionError } from './types';

/** ブラウザで処理可能な PDF ページ数の上限。 */
export const MAX_PDF_PAGES = 200;

/** PDF ページ数がブラウザ内変換の上限以内か確認する。 */
export function assertPdfPageCount(pageCount: number): void {
  if (pageCount > MAX_PDF_PAGES) {
    throw new ConversionError('tooManyPages', `PDF has more than ${MAX_PDF_PAGES} pages`);
  }
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PDF page could not be converted to PNG'));
    }, 'image/png');
  });
}

/**
 * PDF の各ページを順番どおり 1920x1080 の PNG フレームへ描画する。
 *
 * worker は自前で作って GlobalWorkerOptions へ渡しているため、pdfjs は破棄してくれない。
 * 中止・失敗も含めて必ず terminate し、次の変換が新しい worker を張れる状態へ戻す。
 */
export async function pdfToFrames(
  pdfFile: File,
  report?: ProgressReporter,
  signal?: AbortSignal
): Promise<VideoFrame[]> {
  const pdfjs = await import('pdfjs-dist');
  const worker = new Worker(new URL('pdfjs-dist/build/pdf.worker.mjs', import.meta.url), { type: 'module' });
  pdfjs.GlobalWorkerOptions.workerPort = worker;

  try {
    return await renderPdfFrames(pdfjs, pdfFile, report, signal);
  } finally {
    worker.terminate();
    pdfjs.GlobalWorkerOptions.workerPort = null;
  }
}

async function renderPdfFrames(
  pdfjs: typeof import('pdfjs-dist'),
  pdfFile: File,
  report?: ProgressReporter,
  signal?: AbortSignal
): Promise<VideoFrame[]> {
  const pdfDocument = await pdfjs.getDocument({ data: await pdfFile.arrayBuffer() }).promise;
  try {
    assertPdfPageCount(pdfDocument.numPages);
    const frames: VideoFrame[] = [];
    for (let index = 1; index <= pdfDocument.numPages; index += 1) {
      // 1 ページごとに中止を確認する。長い PDF ほど中止から実際に止まるまでが延びるため。
      signal?.throwIfAborted();
      const page = await pdfDocument.getPage(index);
      const sourceViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(
        DEFAULT_CAPTURE_WIDTH / sourceViewport.width,
        DEFAULT_CAPTURE_HEIGHT / sourceViewport.height
      );
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = DEFAULT_CAPTURE_WIDTH;
      canvas.height = DEFAULT_CAPTURE_HEIGHT;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D context is unavailable');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const renderTask = page.render({
        canvas: null,
        canvasContext: context,
        viewport,
        transform: [1, 0, 0, 1, (canvas.width - viewport.width) / 2, (canvas.height - viewport.height) / 2],
      });
      // 描画は数秒かかることがある。中止したら進行中のページも打ち切る。
      const releaseCancel = onAbort(signal, () => renderTask.cancel());
      try {
        await renderTask.promise;
      } finally {
        releaseCancel();
      }
      const png = await canvasToPng(canvas);
      frames.push({
        data: new Uint8Array(await png.arrayBuffer()),
        width: canvas.width,
        height: canvas.height,
      });
      report?.({ stage: 'preparing', current: index, total: pdfDocument.numPages });
    }
    return frames;
  } finally {
    await pdfDocument.destroy();
  }
}
