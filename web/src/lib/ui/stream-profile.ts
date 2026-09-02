/** MP3 beta 配信だけで許可するkeyframe要求の固定間隔。 */
export const MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS = 500;

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
