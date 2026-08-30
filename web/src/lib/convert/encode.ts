import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';

import type { ConversionProgress, ProgressReporter, VideoFrame } from './types';

const CORE_VERSION = '0.12.10';
const CORE_BASE_URL = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`;
const CORE_JS_URL = `${CORE_BASE_URL}/ffmpeg-core.js`;
const CORE_WASM_URL = `${CORE_BASE_URL}/ffmpeg-core.wasm`;
const FRAME_RATE = 1;

/** エンコード段階の内部工程。時間の掛かる待ちが 3 つあるので部分帯域に分ける。 */
export type EncodePhase = 'loading' | 'writing' | 'running';

/**
 * エンコード段階の中で各工程が占める区間（段階内の 0〜1）。
 *
 * UI がエンコード段階へ割り当てている 70〜95% に写すと、読み込み 70→73%、
 * 書き出し 73→80%、実行 80→95% になる。3 工程を別々に 0 から報告すると同じ段階の中で
 * 枚数の表示が戻るため、区間へ写すのはバーの進み具合だけにして、枚数は実際に
 * エンコードされた数だけを出す。
 */
const ENCODE_PHASE_BANDS: Readonly<Record<EncodePhase, readonly [start: number, end: number]>> = {
  loading: [0, 0.12],
  writing: [0.12, 0.4],
  running: [0.4, 1],
};

/** core の取得は残り時間が読めないため、擬似進捗で読み込み区間の中を進める。 */
const LOAD_TICK_MS = 500;
const LOAD_TICK_RATIO = 0.05;
/**
 * 読み込みが終わる前に区間の端へ届かせない（届くと完了の合図が消える）。
 * 表示は整数 % へ丸められるので、丸めた後も完了の 73% と重ならない値にする。
 */
const LOAD_PSEUDO_MAX = 0.8;

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

/** 内部工程の進み具合を、エンコード段階全体の進み具合（0〜1）へ写す。 */
export function encodePhaseRatio(phase: EncodePhase, done: number, total: number): number {
  const [start, end] = ENCODE_PHASE_BANDS[phase];
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return start;
  const within = Math.min(1, Math.max(0, done / total));
  return start + (end - start) * within;
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

/**
 * 読み込み中のバーを擬似進捗で進める。戻り値は停止関数。
 *
 * `toBlobURL` の進捗コールバックは使わない。受信バイト数と Content-Length が食い違うと
 * @ffmpeg/util が本文を読み切った Response へ再度 arrayBuffer() を掛けて失敗するため、
 * キャッシュが冷えている時ほど読み込みそのものを壊しうる。
 *
 * 上限へ達したら自分でタイマーを止める。読み込みが返らないまま（オフライン・CDN 停止）
 * でも、同じ値を延々と通知し続けないため。停止関数は読み込みの完了・失敗の両方で呼び、
 * 遅れて発火した tick が書き出し・実行の報告へ割り込む（枚数が 0 へ戻る）のを防ぐ。
 */
export function startLoadPseudoProgress(total: number, report?: ProgressReporter): () => void {
  let elapsed = 0;
  const timer = setInterval(() => {
    elapsed = Math.min(LOAD_PSEUDO_MAX, elapsed + LOAD_TICK_RATIO);
    report?.({ stage: 'encoding', current: 0, total, ratio: encodePhaseRatio('loading', elapsed, 1) });
    if (elapsed >= LOAD_PSEUDO_MAX) clearInterval(timer);
  }, LOAD_TICK_MS);
  return () => clearInterval(timer);
}

async function loadFfmpegWithProgress(total: number, report?: ProgressReporter): Promise<FFmpeg> {
  const stopPseudoProgress = startLoadPseudoProgress(total, report);
  try {
    return await loadFfmpeg();
  } finally {
    stopPseudoProgress();
  }
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

/**
 * FFmpeg の実行中の報告を組み立てる。
 *
 * バーは生の進み具合から計算する。枚数へ丸めた値を使うと、フレームが少ないほど
 * 段階が粗くなり（1 枚なら 49% まで区間の先頭で止まり 50% で終端へ飛ぶ）、
 * 完了前に 95% を表示してしまう。枚数の表示は従来どおり丸めた値を使う。
 */
export function runningProgress(progress: number, total: number): ConversionProgress {
  return {
    stage: 'encoding',
    current: encodedFrameCount(progress, total),
    total,
    ratio: encodePhaseRatio('running', progress, 1),
  };
}

/** PNG フレーム列を順序を保って VRChat 互換 MP4 にエンコードする。 */
export async function encodeFramesToMp4(frames: readonly VideoFrame[], report?: ProgressReporter): Promise<Blob> {
  if (frames.length === 0) throw new Error('At least one frame is required');
  const total = frames.length;
  // エンコードは「core 読み込み → フレーム書き出し → FFmpeg 実行」と進む。枚数は実行が
  // 始まるまで動かせない（書き出し枚数を出すと実行の開始で 0 に戻る）ため、枚数は据え置き、
  // バーだけを工程ごとの部分帯域で進める。
  report?.({ stage: 'encoding', current: 0, total, ratio: encodePhaseRatio('loading', 0, 1) });
  const ffmpeg = await loadFfmpegWithProgress(total, report);
  try {
    for (const [index, frame] of frames.entries()) {
      await ffmpeg.writeFile(frameFileName(index), new Uint8Array(frame.data));
      report?.({ stage: 'encoding', current: 0, total, ratio: encodePhaseRatio('writing', index + 1, total) });
    }
    ffmpeg.on('progress', ({ progress }) => report?.(runningProgress(progress, total)));
    const status = await ffmpeg.exec(buildFrameEncodeArgs());
    if (status !== 0) throw new Error(`FFmpeg exited with ${status}`);
    return await readMp4(ffmpeg, 'output.mp4');
  } finally {
    ffmpeg.terminate();
  }
}
