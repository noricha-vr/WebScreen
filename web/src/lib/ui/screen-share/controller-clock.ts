import { isExpiryWarning, type LiveStreamSession, secondsUntil } from './session';
import type { ScreenShareView } from './view';

/** 現在時刻の配信期限表示を更新し、期限切れかを返す。 */
export function updateStreamClock(
  view: ScreenShareView,
  live: LiveStreamSession,
  expiresBarTotalSeconds: number,
  now: number
): boolean {
  const remaining = secondsUntil(live.extendExpiresAt, now);
  view.updateClock(
    live.startedAt,
    now,
    remaining,
    isExpiryWarning(live.extendExpiresAt, now),
    expiresBarTotalSeconds
  );
  return remaining === 0;
}
