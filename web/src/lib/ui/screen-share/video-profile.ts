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
