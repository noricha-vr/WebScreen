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

/**
 * 画面選択後もこのページ（WebScreen）にフォーカスを留めて getDisplayMedia を呼ぶ。
 * タブ・ウィンドウ共有では共有先へフォーカスを移さず、利用者を WebScreen に留める。
 * monitor（画面全体）はフォーカス対象にできないため設定しない（InvalidStateError になる）。
 */
export async function getDisplayMediaKeepingFocus(
  constraints: DisplayMediaStreamOptions,
  getDisplayMedia: (constraints: DisplayMediaStreamOptions) => Promise<MediaStream>,
  createController: (() => CaptureController) | null
): Promise<MediaStream> {
  if (createController === null) return getDisplayMedia(constraints);
  const controller = createController();
  const stream = await getDisplayMedia({ ...constraints, controller });
  // setFocusBehavior は Promise 解決直後の短い窓でしか受け付けず、monitor 共有では InvalidStateError になる。
  const displaySurface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
  if (displaySurface === 'browser' || displaySurface === 'window') {
    try {
      controller.setFocusBehavior('no-focus-change');
    } catch (error) {
      // フォーカス抑止は補助機能なので、拒否されても配信開始は続ける（無言で握り潰さない）。
      console.warn('Failed to preserve WebScreen focus after screen selection', error);
    }
  }
  return stream;
}
