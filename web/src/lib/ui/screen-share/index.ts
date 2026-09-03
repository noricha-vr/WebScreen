import { ScreenShareControllerImpl } from './controller';
import type { ScreenShareDependencies } from './controller';
import { requestJson } from '../request-json';
import { waitForStreamReady } from './stream-api';
import { startWhipPublisher } from '../whip-publisher';
import { browserPreviewPreference } from './preview-preference';

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

const BROWSER_DEPENDENCIES: ScreenShareDependencies = {
  requestJson,
  startWhipPublisher,
  waitForStreamReady: (id, signal) => waitForStreamReady(id, requestJson, undefined, signal),
  getDisplayMedia: async (constraints) => {
    if (typeof CaptureController === 'undefined') {
      return navigator.mediaDevices.getDisplayMedia(constraints);
    }
    const controller = new CaptureController();
    const stream = await navigator.mediaDevices.getDisplayMedia({ ...constraints, controller });
    const displaySurface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
    if (displaySurface === 'browser' || displaySurface === 'window') {
      try {
        controller.setFocusBehavior('no-focus-change');
      } catch (error) {
        // 共有先の種類や解決後の経過時間により拒否されても、配信開始は継続する。
        console.warn('Failed to preserve WebScreen focus after screen selection', error);
      }
    }
    return stream;
  },
  previewPreference: browserPreviewPreference,
  delay: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
  now: () => Date.now(),
  createStartToken: () => globalThis.crypto.randomUUID(),
  sendBeacon: (url, data) => navigator.sendBeacon(url, data),
  onPageHide: (handler) => window.addEventListener('pagehide', handler),
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
