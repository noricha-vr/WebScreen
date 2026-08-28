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

async function loadFfmpeg(): Promise<FFmpeg> {
  const ffmpeg = new FFmpeg();
  // Workers Assets に収まらない core/wasm を CDN から取得し、同一オリジン Blob URL として Worker に渡す。
  const [coreURL, wasmURL] = await Promise.all([
    toBlobURL(CORE_JS_URL, 'text/javascript'),
    toBlobURL(CORE_WASM_URL, 'application/wasm'),
  ]);
  await ffmpeg.load({ coreURL, wasmURL });
  return ffmpeg;
}

async function readMp4(ffmpeg: FFmpeg, outputFile: string): Promise<Blob> {
  const output = await ffmpeg.readFile(outputFile);
  if (!(output instanceof Uint8Array)) throw new Error('FFmpeg output is not binary data');
  return new Blob([output.slice().buffer], { type: 'video/mp4' });
}

/** FFmpeg の 0〜1 の進み具合を、表示単位のエンコード済みフレーム数へ丸める。 */
export function encodedFrameCount(progress: number, total: number): number {
  if (!Number.isFinite(progress)) return 0;
  return Math.min(total, Math.max(0, Math.round(progress * total)));
}

/** PNG フレーム列を順序を保って VRChat 互換 MP4 にエンコードする。 */
export async function encodeFramesToMp4(frames: readonly VideoFrame[], report?: ProgressReporter): Promise<Blob> {
  if (frames.length === 0) throw new Error('At least one frame is required');
  const total = frames.length;
  // エンコードは「core 読み込み → フレーム書き出し → FFmpeg 実行」と進むが、3 つを
  // 別々に 0 から報告すると同じ段階の中で枚数の表示が戻る。進捗の単位を「エンコード済み
  // フレーム数」に統一し、時間のほとんどを占める実行の進み具合だけを報告する。
  // note: 読み込みと書き出しの間は帯域の先頭で止まる。キャッシュが冷えている時や
  // フレームが多い時はここが目に見える停滞になる（段階を分けて解消する: Issue #80）。
  report?.({ stage: 'encoding', current: 0, total });
  const ffmpeg = await loadFfmpeg();
  try {
    for (const [index, frame] of frames.entries()) {
      await ffmpeg.writeFile(frameFileName(index), new Uint8Array(frame.data));
    }
    ffmpeg.on('progress', ({ progress }) =>
      report?.({ stage: 'encoding', current: encodedFrameCount(progress, total), total })
    );
    const status = await ffmpeg.exec(buildFrameEncodeArgs());
    if (status !== 0) throw new Error(`FFmpeg exited with ${status}`);
    return await readMp4(ffmpeg, 'output.mp4');
  } finally {
    ffmpeg.terminate();
  }
}
