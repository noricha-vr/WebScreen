import { MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS } from './whip-publisher';

/** URL queryで許可されたMP3 beta配信だけに固定keyframe要求を有効化する。 */
export function keyframeRequestIntervalForSearch(
  search: string
): typeof MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS | undefined {
  const profiles = new URLSearchParams(search).getAll('stream-profile');
  return profiles.length === 1 && profiles[0] === 'mp3-beta'
    ? MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS
    : undefined;
}
