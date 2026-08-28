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
  report?: ProgressReporter
): Promise<Blob> {
  if (files.length === 0) throw new Error('At least one file is required');
  const frames = kind === 'pdf' ? await pdfToFrames(files[0]!, report) : await imageFilesToFrames(files, report);
  return encodeFramesToMp4(frames, report);
}

/** 撮影順で返された URL 画像群を VRChat 互換 MP4 にする。 */
export async function convertImageUrlsToMp4(urls: readonly string[], report?: ProgressReporter): Promise<Blob> {
  return encodeFramesToMp4(await imageUrlsToFrames(urls, report), report);
}

export { ConversionError, type ConversionProgress, type ConversionStage, type VideoFrame } from './types';
