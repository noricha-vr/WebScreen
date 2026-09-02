/** MP3 beta 配信だけで許可するkeyframe要求の固定間隔。 */
export const MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS = 500;

/** 検証用リアルタイム映像プロファイルで許可する sender bitrate。 */
export const REALTIME_VIDEO_MAX_BITRATES = [1_200_000, 1_500_000, 2_000_000] as const;

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
  // mp3-beta の 500 ms キーフレーム要求との併用は未検証の最大負荷条件になるため、組み合わせごと拒否する。
  if (new URLSearchParams(search).has('stream-profile')) return undefined;

  // bitrate は暗黙の既定を持たせず明示必須にする（未指定・不正・重複はいずれも候補ごと無効化して
  // 既定プロファイルへ fail-closed する）。検証結果の解釈で「どの上限で測ったか」を曖昧にしないため。
  const values = new URLSearchParams(search).getAll('video-max-bitrate');
  if (values.length !== 1) return undefined;

  switch (values[0]) {
    case '1200000': return 1_200_000;
    case '1500000': return 1_500_000;
    case '2000000': return 2_000_000;
    default: return undefined;
  }
}
