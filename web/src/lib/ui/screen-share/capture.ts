import {
  displayAudioConstraint,
  resolveAudioProfileForSearch,
  type AudioProfile,
} from '../audio-profile';
import { captureVideoConstraints } from './video-profile';

/** 現在の query から音声プロファイルを確定する。 */
export function currentAudioProfile(): AudioProfile {
  return resolveAudioProfileForSearch(globalThis.window?.location?.search ?? '');
}

/** 選択済み MediaStream の track を一度だけ停止する。 */
export class CaptureHandle {
  private disposed = false;

  constructor(readonly media: MediaStream) {}

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const track of this.media.getTracks()) track.stop();
  }
}

const CAPTURE_HANDLES = new WeakMap<MediaStream, CaptureHandle>();

/** 同じMediaStreamへ同一CaptureHandleを割り当てる。 */
export function captureHandleFor(media: MediaStream): CaptureHandle {
  const existing = CAPTURE_HANDLES.get(media);
  if (existing) return existing;
  const capture = new CaptureHandle(media);
  CAPTURE_HANDLES.set(media, capture);
  return capture;
}

/** 画面選択へ渡す映像・音声制約を組み立てる。 */
export function displayMediaConstraints(profile: AudioProfile): MediaStreamConstraints {
  return {
    // ピッカー種別は指定せず、画面全体・ウィンドウ・タブを利用者に選ばせる。
    video: captureVideoConstraints(),
    audio: displayAudioConstraint(profile),
  };
}
