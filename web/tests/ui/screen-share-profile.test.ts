import { describe, expect, test } from 'bun:test';

import { MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS } from '../../src/lib/ui/whip-publisher';
import { hasSingleExactQueryValue, keyframeRequestIntervalForSearch } from '../../src/lib/ui/stream-profile';

describe('MP3 beta stream profile', () => {
  test('共通のquery判定はキーと値の完全一致を重複なく要求する', () => {
    expect(hasSingleExactQueryValue('?stream-profile=mp3-beta', 'stream-profile', 'mp3-beta')).toBe(true);
    expect(hasSingleExactQueryValue('?stream-profile=mp3-beta&stream-profile=mp3-beta', 'stream-profile', 'mp3-beta')).toBe(false);
  });

  test('stream-profile=mp3-betaが1個だけの時に固定intervalを返す', () => {
    expect(keyframeRequestIntervalForSearch('?stream-profile=mp3-beta')).toBe(
      MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS
    );
  });

  test('欠落・未知・重複のstream-profileはkeyframe requesterを無効にする', () => {
    expect(keyframeRequestIntervalForSearch('')).toBeUndefined();
    expect(keyframeRequestIntervalForSearch('?stream-profile=aac')).toBeUndefined();
    expect(
      keyframeRequestIntervalForSearch('?stream-profile=mp3-beta&stream-profile=mp3-beta')
    ).toBeUndefined();
  });

  test('混在重複・空値・case違いのstream-profileを拒否する', () => {
    expect(
      keyframeRequestIntervalForSearch('?stream-profile=mp3-beta&stream-profile=aac')
    ).toBeUndefined();
    expect(keyframeRequestIntervalForSearch('?stream-profile=')).toBeUndefined();
    expect(keyframeRequestIntervalForSearch('?stream-profile=MP3-BETA')).toBeUndefined();
  });
});
