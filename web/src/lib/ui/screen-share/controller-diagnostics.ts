import type { ClientErrorReport } from '../../contracts/client-error';
import { reportClientError } from '../client-error-report';
import { isUnauthorizedRequestError } from '../request-json';
import { WhipPublishError, type VideoPublishStats } from '../whip-publisher';
import {
  buildStreamDiagnosticSnapshot,
  classifyStreamFailure,
  type StreamFailureKind,
} from './diagnostics';
import {
  displaySurfaceOf,
  userAgentString,
  videoSettingsOf,
} from './controller-helpers';
import {
  isStreamAlreadyLiveError,
  messageKeyForError,
  retryAfterSecondsForError,
  ScreenShareView,
  StreamHealthError,
} from './view';

/** 失敗診断の状態・匿名報告・表示をcontrollerから分離して所有する。 */
export class ScreenShareDiagnostics {
  private streamId: string | null = null;
  private lastStats: VideoPublishStats | null = null;
  private snapshot: Record<string, unknown> | null = null;

  constructor(
    private readonly view: ScreenShareView,
    private readonly now: () => number,
    private readonly reportFailure: (report: ClientErrorReport) => void = reportClientError
  ) {}

  reset(): void {
    this.streamId = null;
    this.lastStats = null;
    this.snapshot = null;
  }

  setStreamId(streamId: string): void {
    this.streamId = streamId;
  }

  rememberStats(stats: VideoPublishStats | null): void {
    this.lastStats = stats;
  }

  snapshotJson(): string | null {
    return this.snapshot ? JSON.stringify(this.snapshot, null, 2) : null;
  }

  markSuccess(): void {
    this.snapshot = null;
    this.view.setDiagnosticsButtonVisible(false);
  }

  handleStartError(error: unknown, media: MediaStream | null, hasLive: boolean): void {
    if (isUnauthorizedRequestError(error)) {
      this.view.show('login');
      return;
    }
    const kind = startFailureKind(error);
    if (kind) this.recordFailure(kind, this.lastStats, media);
    else this.snapshot = null;
    this.showError(error, hasLive);
  }

  recordFailure(
    kind: StreamFailureKind,
    stats: VideoPublishStats | null,
    media: MediaStream | null
  ): void {
    try {
      const failureCode = classifyStreamFailure({ kind, stats, health: null });
      this.reportFailure({ stage: 'stream', errorCode: failureCode });
      this.snapshot = buildStreamDiagnosticSnapshot({
        streamId: this.streamId,
        at: new Date(this.now()).toISOString(),
        userAgent: userAgentString(),
        displaySurface: displaySurfaceOf(media),
        video: videoSettingsOf(media),
        stats,
        health: null,
        failureCode,
      });
    } catch (error) {
      console.warn('Failed to record stream failure diagnostics', error);
    }
  }

  showError(error: unknown, hasLive: boolean): void {
    this.view.showError(
      messageKeyForError(error),
      hasLive,
      isStreamAlreadyLiveError(error),
      retryAfterSecondsForError(error)
    );
    this.view.setDiagnosticsButtonVisible(this.snapshot !== null);
  }

  clearAndShowError(error: unknown, hasLive: boolean): void {
    this.snapshot = null;
    this.showError(error, hasLive);
  }
}

/** 開始例外のうち、匿名診断へ送る失敗種別だけを返す。 */
function startFailureKind(error: unknown): StreamFailureKind | null {
  if (error instanceof StreamHealthError) return 'healthTimeout';
  if (error instanceof WhipPublishError) return 'publishFailed';
  if (error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return 'displayDenied';
  }
  return null;
}
