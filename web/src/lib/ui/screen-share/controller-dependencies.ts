import type { ClientErrorReport } from '../../contracts/client-error';
import type { ScreenShareAnalyticsEvent } from '../analytics';
import type { requestJson } from '../request-json';
import type { startWhipPublisher } from '../whip-publisher';
import type { PreviewPreferenceStore } from './preview-preference';
import type { RecordingDependencies } from './recording';

/** DOM controller の外部境界。テストでは画面・API・WHIP を独立して差し替える。 */
export interface ScreenShareDependencies extends RecordingDependencies {
  requestJson: typeof requestJson;
  startWhipPublisher: typeof startWhipPublisher;
  waitForStreamReady: (streamId: string, signal?: AbortSignal) => Promise<boolean>;
  getDisplayMedia: typeof navigator.mediaDevices.getDisplayMedia;
  previewPreference: PreviewPreferenceStore;
  delay?: (ms: number) => Promise<void>;
  now: () => number;
  createStartToken?: () => string;
  search?: () => string;
  sendBeacon: (url: string, data?: BodyInit | null) => boolean;
  onPageHide: (handler: () => void) => void;
  /** 失敗の匿名報告。既定は client-error-report の reportClientError。 */
  reportStreamFailure?: (report: ClientErrorReport) => void;
  /** 成功境界の計測。失敗しても配信操作を止めない。 */
  trackAnalytics?: (event: ScreenShareAnalyticsEvent) => void;
}
