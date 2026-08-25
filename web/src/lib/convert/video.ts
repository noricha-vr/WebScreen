import { encodeVideoToMp4 } from './encode';
import type { ProgressReporter } from './types';

/** 動画ファイルを FFmpeg.wasm で VRChat 互換 MP4 へトランスコードする。 */
export async function videoToMp4(video: File, report?: ProgressReporter): Promise<Blob> {
  return encodeVideoToMp4(video, report);
}
