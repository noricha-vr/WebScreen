import type { UploadKind } from '../contracts/api';
import { encodeFramesToMp4 } from './encode';
import { imageFilesToFrames } from './image';
import { imageUrlsToFrames } from './imageUrls';
import { pdfToFrames } from './pdf';
import type { ProgressReporter } from './types';

/** ファイル種別に応じてブラウザ内で VRChat 互換 MP4 を生成する。 */
export async function convertFilesToMp4(
  files: readonly File[],
  kind: Exclude<UploadKind, 'web'>,
  report?: ProgressReporter,
  signal?: AbortSignal
): Promise<Blob> {
  if (files.length === 0) throw new Error('At least one file is required');
  const frames =
    kind === 'pdf'
      ? await pdfToFrames(files[0]!, report, signal)
      : await imageFilesToFrames(files, report, signal);
  return encodeFramesToMp4(frames, report, signal);
}

/** 撮影順で返された URL 画像群を VRChat 互換 MP4 にする。 */
export async function convertImageUrlsToMp4(
  urls: readonly string[],
  report?: ProgressReporter,
  signal?: AbortSignal
): Promise<Blob> {
  return encodeFramesToMp4(await imageUrlsToFrames(urls, report, signal), report, signal);
}

export { ConversionError, type ConversionProgress, type ConversionStage, type VideoFrame } from './types';
export {
  API_REQUEST_TIMEOUT_MS,
  isUserAborted,
  StageTimeoutError,
  STAGE_TIMEOUT_CODES,
  UPLOAD_PUT_TIMEOUT_MS,
  withStageTimeout,
  type StageTimeoutCode,
} from './timeouts';
