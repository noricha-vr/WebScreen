/**
 * PDF to Movie WASM Converter
 * PDF.js と FFmpeg.wasm を使用してブラウザ内で PDF → MP4 変換を行う
 */

// CDN URLs (jsdelivr has proper CORS headers)
const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.9.155/build/pdf.min.mjs';
const PDFJS_WORKER_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.9.155/build/pdf.worker.min.mjs';
const FFMPEG_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
const FFMPEG_UTIL_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js';
const FFMPEG_CORE_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.js';
const FFMPEG_CORE_WASM_CDN = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm/ffmpeg-core.wasm';
// Worker URL (ローカルにホストしてクロスオリジン制約を回避 - 絶対URLで指定)
const FFMPEG_WORKER_URL = new URL('/static/js/ffmpeg/worker.js', window.location.origin).href;

let pdfjsLib = null;
let FFmpeg = null;
let fetchFile = null;

/**
 * ライブラリを動的にロード
 * @param {function} onProgress - 進捗コールバック
 */
async function loadLibraries(onProgress) {
    onProgress?.('Loading PDF.js...');

    // PDF.js をロード
    const pdfjs = await import(PDFJS_CDN);
    pdfjsLib = pdfjs;
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN;

    onProgress?.('Loading FFmpeg.wasm...');

    // FFmpeg.wasm をロード
    const ffmpegModule = await import(FFMPEG_CDN);
    FFmpeg = ffmpegModule.FFmpeg;

    const utilModule = await import(FFMPEG_UTIL_CDN);
    fetchFile = utilModule.fetchFile;

    onProgress?.('Libraries loaded');
}

/**
 * PDFファイルをPNG画像配列に変換
 * @param {File} pdfFile - PDFファイル
 * @param {function} onProgress - 進捗コールバック
 * @returns {Promise<Uint8Array[]>} PNG画像データの配列
 */
async function pdfToImages(pdfFile, onProgress) {
    const arrayBuffer = await pdfFile.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = pdf.numPages;
    const images = [];

    for (let i = 1; i <= numPages; i++) {
        onProgress?.(`Rendering page ${i}/${numPages}...`);

        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1 });

        // 1920px幅に合わせてスケールを計算
        const TARGET_WIDTH = 1920;
        const scale = TARGET_WIDTH / viewport.width;
        const scaledViewport = page.getViewport({ scale });

        // Canvas作成
        const canvas = document.createElement('canvas');
        canvas.width = scaledViewport.width;
        canvas.height = scaledViewport.height;
        const ctx = canvas.getContext('2d');

        // 背景を白で塗りつぶし
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // PDFをレンダリング
        await page.render({
            canvasContext: ctx,
            viewport: scaledViewport
        }).promise;

        // PNGに変換
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const pngData = new Uint8Array(await blob.arrayBuffer());
        images.push(pngData);

        // メモリ解放
        canvas.width = 0;
        canvas.height = 0;
    }

    return images;
}

/**
 * PNG画像配列をMP4動画に変換
 * @param {Uint8Array[]} images - PNG画像データの配列
 * @param {number} frameSec - 1ページあたりの表示秒数
 * @param {function} onProgress - 進捗コールバック
 * @returns {Promise<Blob>} MP4動画のBlob
 */
async function imagesToMp4(images, frameSec, onProgress) {
    onProgress?.('Initializing FFmpeg...');

    const ffmpeg = new FFmpeg();

    // FFmpegの進捗イベントを設定
    ffmpeg.on('progress', ({ progress }) => {
        const percent = Math.round(progress * 100);
        onProgress?.(`Encoding video... ${percent}%`);
    });

    // FFmpeg Core をロード（classWorkerURLをローカルに指定してクロスオリジン制約を回避）
    await ffmpeg.load({
        coreURL: FFMPEG_CORE_CDN,
        wasmURL: FFMPEG_CORE_WASM_CDN,
        classWorkerURL: FFMPEG_WORKER_URL
    });

    onProgress?.('Writing frames...');

    // frame_secに応じてフレームを複製（6fpsで1秒 = 6フレーム）
    const FRAMES_PER_SECOND = 6;
    const framesPerPage = frameSec * FRAMES_PER_SECOND;
    let frameIndex = 0;

    for (let i = 0; i < images.length; i++) {
        const image = images[i];
        // 同じ画像を framesPerPage 回書き込む（各回でコピーを作成してdetached対策）
        for (let j = 0; j < framesPerPage; j++) {
            const frameName = `frame${String(frameIndex).padStart(4, '0')}.png`;
            // Uint8Arrayをコピーして渡す（FFmpegがArrayBufferを転送してしまうため）
            await ffmpeg.writeFile(frameName, new Uint8Array(image));
            frameIndex++;
        }
        onProgress?.(`Writing frames... ${i + 1}/${images.length} pages`);
    }

    onProgress?.('Encoding video...');

    // ffmpegで動画生成（現在のバックエンドと同じ設定）
    await ffmpeg.exec([
        '-framerate', '6',
        '-i', 'frame%04d.png',
        '-vf', "scale='min(1280,iw)':-2",
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-preset', 'slow',
        '-profile:v', 'baseline',
        '-bf', '0',
        '-g', '1',
        '-tune', 'stillimage',
        '-y', 'output.mp4'
    ]);

    onProgress?.('Reading output...');

    // 出力ファイルを読み取り
    const data = await ffmpeg.readFile('output.mp4');

    // クリーンアップ
    ffmpeg.terminate();

    return new Blob([data.buffer], { type: 'video/mp4' });
}

/**
 * PDFファイルをMP4動画に変換
 * @param {File} pdfFile - PDFファイル
 * @param {number} frameSec - 1ページあたりの表示秒数
 * @param {function} onProgress - 進捗コールバック
 * @returns {Promise<Blob>} MP4動画のBlob
 */
export async function convertPdfToMp4(pdfFile, frameSec, onProgress) {
    // ライブラリをロード
    if (!pdfjsLib || !FFmpeg) {
        await loadLibraries(onProgress);
    }

    // PDFを画像に変換
    const images = await pdfToImages(pdfFile, onProgress);

    // 画像を動画に変換
    const mp4Blob = await imagesToMp4(images, frameSec, onProgress);

    onProgress?.('Conversion complete!');

    return mp4Blob;
}
