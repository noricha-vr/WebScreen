import { realtimeVideoMaxBitrateForSearch } from '../stream-profile';
import type { WhipVideoSettings } from '../whip-publisher';

/** Capture・track・sender に同じ値を渡す固定映像プロファイル。 */
export const SCREEN_SHARE_VIDEO_SETTINGS = {
  width: 1280,
  height: 720,
  frameRate: 30,
  maxBitrate: 1_200_000,
  contentHint: 'detail',
  degradationPreference: 'maintain-resolution',
  scaleResolutionDownBy: 1,
} as const;

/** Issue #177 の検証時だけ query で選べるリアルタイム優先の映像プロファイル。 */
export const REALTIME_SCREEN_SHARE_VIDEO_SETTINGS = {
  width: 1280,
  height: 720,
  frameRate: 30,
  maxBitrate: 1_500_000,
  contentHint: 'motion',
  degradationPreference: 'maintain-framerate',
} as const;

/** URL query から画面共有の送出設定を解決する。 */
export function resolveScreenShareVideoSettingsForSearch(search: string): WhipVideoSettings {
  const maxBitrate = realtimeVideoMaxBitrateForSearch(search);
  if (maxBitrate === undefined) return SCREEN_SHARE_VIDEO_SETTINGS;

  return { ...REALTIME_SCREEN_SHARE_VIDEO_SETTINGS, maxBitrate };
}

/** 画面取得に渡す固定制約を返す。 */
export function captureVideoConstraints(): MediaTrackConstraints {
  return {
    width: { ideal: SCREEN_SHARE_VIDEO_SETTINGS.width },
    height: { ideal: SCREEN_SHARE_VIDEO_SETTINGS.height },
    frameRate: {
      ideal: SCREEN_SHARE_VIDEO_SETTINGS.frameRate,
      max: SCREEN_SHARE_VIDEO_SETTINGS.frameRate,
    },
  };
}
