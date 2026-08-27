import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

import type { ProgressReporter, VideoFrame } from './types';

const CORE_VERSION = '0.12.10';
const CORE_BASE_URL = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
const CORE_JS_URL = `${CORE_BASE_URL}/ffmpeg-core.js`;
const CORE_WASM_URL = `${CORE_BASE_URL}/ffmpeg-core.wasm`;
const FRAME_RATE = 1;

/** フレームの順序を FFmpeg の連番ファイル名へ固定する。 */
export function frameFileName(index: number): string {
  return `frame-${String(index).padStart(6, '0')}.png`;
}

/** フレーム列を VRChat 互換 MP4 にする引数を生成する。 */
export function buildFrameEncodeArgs(outputFile = 'output.mp4'): string[] {
  return [
    '-framerate',
    String(FRAME_RATE),
    '-i',
    'frame-%06d.png',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'baseline',
    '-bf',
    '0',
    '-g',
    '1',
    '-movflags',
    '+faststart',
    '-an',
    '-y',
    outputFile,
  ];
}

async function loadFfmpeg(report?: ProgressReporter): Promise<FFmpeg> {
  report?.({ current: 0, total: 1 });
  const ffmpeg = new FFmpeg();
  // Workers Assets に収まらない core/wasm を CDN から取得し、同一オリジン Blob URL として Worker に渡す。
  const [coreURL, wasmURL] = await Promise.all([
    toBlobURL(CORE_JS_URL, 'text/javascript'),
    toBlobURL(CORE_WASM_URL, 'application/wasm'),
  ]);
  await ffmpeg.load({ coreURL, wasmURL });
  report?.({ current: 1, total: 1 });
  return ffmpeg;
}

async function readMp4(ffmpeg: FFmpeg, outputFile: string): Promise<Blob> {
  const output = await ffmpeg.readFile(outputFile);
  if (!(output instanceof Uint8Array)) throw new Error('FFmpeg output is not binary data');
  return new Blob([output.slice().buffer], { type: 'video/mp4' });
}

/** PNG フレーム列を順序を保って VRChat 互換 MP4 にエンコードする。 */
export async function encodeFramesToMp4(frames: readonly VideoFrame[], report?: ProgressReporter): Promise<Blob> {
  if (frames.length === 0) throw new Error('At least one frame is required');
  const ffmpeg = await loadFfmpeg();
  try {
    for (const [index, frame] of frames.entries()) {
      await ffmpeg.writeFile(frameFileName(index), new Uint8Array(frame.data));
      report?.({ current: index + 1, total: frames.length });
    }
    ffmpeg.on('progress', ({ progress }) => report?.({ current: Math.round(progress * 100), total: 100 }));
    const status = await ffmpeg.exec(buildFrameEncodeArgs());
    if (status !== 0) throw new Error(`FFmpeg exited with ${status}`);
    return await readMp4(ffmpeg, 'output.mp4');
  } finally {
    ffmpeg.terminate();
  }
}
