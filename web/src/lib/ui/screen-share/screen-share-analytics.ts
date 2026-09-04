import type { ScreenShareAnalyticsEvent } from '../analytics';
import type { LiveStreamSession } from './session';

/** 画面共有の成功イベントを安全かつ配信単位 one-shot で通知する。 */
export class ScreenShareAnalyticsObserver {
  private readonly readyStreams = new WeakSet<LiveStreamSession>();

  constructor(private readonly track?: (event: ScreenShareAnalyticsEvent) => void) {}

  emit(event: ScreenShareAnalyticsEvent): void {
    try {
      this.track?.(event);
    } catch {
      // 計測 observer の失敗で画面共有を壊さない。
    }
  }

  ready(stream: LiveStreamSession): void {
    if (this.readyStreams.has(stream)) return;
    this.readyStreams.add(stream);
    this.emit('screen_share_ready');
  }
}
