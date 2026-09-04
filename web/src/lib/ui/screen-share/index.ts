import { ScreenShareControllerImpl } from './controller';
import type { ScreenShareDependencies } from './controller';
import { requestJson } from '../request-json';
import { waitForStreamReady } from './stream-api';
import { startWhipPublisher } from '../whip-publisher';
import { browserPreviewPreference } from './preview-preference';
import { getDisplayMediaKeepingFocus } from './capture';
import { trackScreenShareEvent } from '../analytics';

export type { ScreenShareDependencies } from './controller';
export {
  EXPIRY_WARNING_SECONDS,
  HEARTBEAT_INTERVAL_MS,
  isExpiryWarning,
  releaseScreenShare,
  secondsUntil,
} from './session';
export {
  REALTIME_SCREEN_SHARE_VIDEO_SETTINGS,
  resolveScreenShareVideoSettingsForSearch,
  SCREEN_SHARE_VIDEO_SETTINGS,
} from './video-profile';
export { MAX_RECORDING_BYTES, ScreenRecorder } from './recorder';
export type {
  LocalRecording,
  MediaRecorderConstructor,
  RecorderError,
  RecorderErrorCode,
  RecorderState,
} from './recorder';

const BROWSER_DEPENDENCIES: ScreenShareDependencies = {
  requestJson,
  startWhipPublisher,
  waitForStreamReady: (id, signal) => waitForStreamReady(id, requestJson, undefined, signal),
  getDisplayMedia: (constraints) => getDisplayMediaKeepingFocus(
    constraints ?? {},
    (options) => navigator.mediaDevices.getDisplayMedia(options),
    typeof CaptureController === 'undefined' ? null : () => new CaptureController()
  ),
  previewPreference: browserPreviewPreference,
  delay: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
  now: () => Date.now(),
  createStartToken: () => globalThis.crypto.randomUUID(),
  sendBeacon: (url, data) => navigator.sendBeacon(url, data),
  onPageHide: (handler) => window.addEventListener('pagehide', handler),
  trackAnalytics: trackScreenShareEvent,
};

/** 既定のbrowser依存を備え、従来の1引数constructorを維持する公開Facade。 */
export class ScreenShareController extends ScreenShareControllerImpl {
  constructor(root: HTMLElement, dependencies: ScreenShareDependencies = BROWSER_DEPENDENCIES) {
    super(root, dependencies);
  }
}

/** 画面共有カードへイベントと配信状態を配線する。 */
export function mountScreenSharePage(root: HTMLElement): void {
  new ScreenShareController(root, BROWSER_DEPENDENCIES).mount();
}
