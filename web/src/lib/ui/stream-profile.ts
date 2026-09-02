/** MP3 beta 配信だけで許可するkeyframe要求の固定間隔。 */
export const MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS = 500;

/** 検証用リアルタイム映像プロファイルで許可する sender bitrate。 */
export const REALTIME_VIDEO_MAX_BITRATES = [1_200_000, 1_500_000, 2_000_000] as const;

/** 検証用リアルタイム映像プロファイルで bitrate 指定がない時の暫定値。 */
export const DEFAULT_REALTIME_VIDEO_MAX_BITRATE = 1_500_000;

/** 検証用リアルタイム映像プロファイルで許可する sender bitrate の型。 */
export type RealtimeVideoMaxBitrate = (typeof REALTIME_VIDEO_MAX_BITRATES)[number];

/** URL query に指定された値が重複なく完全一致するかを判定する。 */
export function hasSingleExactQueryValue(search: string, name: string, expectedValue: string): boolean {
  const values = new URLSearchParams(search).getAll(name);
  return values.length === 1 && values[0] === expectedValue;
}

/** URL queryで許可されたMP3 beta配信だけに固定keyframe要求を有効化する。 */
export function keyframeRequestIntervalForSearch(
  search: string
): typeof MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS | undefined {
  return hasSingleExactQueryValue(search, 'stream-profile', 'mp3-beta')
    ? MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS
    : undefined;
}

/** URL query が検証用リアルタイム映像プロファイルを完全一致で要求した時だけ bitrate を返す。 */
export function realtimeVideoMaxBitrateForSearch(search: string): RealtimeVideoMaxBitrate | undefined {
  if (!hasSingleExactQueryValue(search, 'video-profile', 'realtime')) return undefined;

  const values = new URLSearchParams(search).getAll('video-max-bitrate');
  if (values.length === 0) return DEFAULT_REALTIME_VIDEO_MAX_BITRATE;
  if (values.length !== 1) return undefined;

  // bitrate query が不正なら realtime 候補自体を無効化し、既定プロファイルへ fail-closed する。
  switch (values[0]) {
    case '1200000': return 1_200_000;
    case '1500000': return 1_500_000;
    case '2000000': return 2_000_000;
    default: return undefined;
  }
}
