import { describe, expect, test } from 'bun:test';

import { MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS } from '../../src/lib/ui/whip-publisher';
import {
  hasSingleExactQueryValue,
  keyframeRequestIntervalForSearch,
  reusableStreamIdForSearch,
} from '../../src/lib/ui/stream-profile';
import {
  REALTIME_SCREEN_SHARE_VIDEO_SETTINGS,
  resolveScreenShareVideoSettingsForSearch,
  SCREEN_SHARE_VIDEO_SETTINGS,
} from '../../src/lib/ui/screen-share/video-profile';

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

describe('固定配信 ID query', () => {
  test('stream-id が12文字で一つだけの時に再利用する ID を返す', () => {
    expect(reusableStreamIdForSearch('?stream-id=Ab12Cd34Ef56')).toBe('Ab12Cd34Ef56');
  });

  test.each([
    '',
    '?stream-id=short',
    '?stream-id=Ab12Cd34Ef-6',
    '?stream-id=Ab12Cd34Ef56&stream-id=Ab12Cd34Ef56',
    '?stream-id=Ab12Cd34Ef56&stream-id=Zy98Xw76Vu54',
  ])('欠落・不正・重複の stream-id は通常発行へ fail-closed する: %s', (search) => {
    expect(reusableStreamIdForSearch(search)).toBeUndefined();
  });
});

describe('検証用リアルタイム映像プロファイル', () => {
  test('queryなしでは既定の画質優先設定をそのまま返す', () => {
    expect(resolveScreenShareVideoSettingsForSearch('')).toEqual(SCREEN_SHARE_VIDEO_SETTINGS);
  });

  test('video-profile=realtime と明示 bitrate の組で解像度固定を外した候補を返す', () => {
    expect(resolveScreenShareVideoSettingsForSearch('?video-profile=realtime&video-max-bitrate=1500000')).toEqual(
      REALTIME_SCREEN_SHARE_VIDEO_SETTINGS
    );
    expect(REALTIME_SCREEN_SHARE_VIDEO_SETTINGS).not.toHaveProperty('scaleResolutionDownBy');
  });

  test('bitrate 未指定の realtime は既定設定へ戻す', () => {
    expect(resolveScreenShareVideoSettingsForSearch('?video-profile=realtime')).toEqual(SCREEN_SHARE_VIDEO_SETTINGS);
  });

  test('許可された realtime bitrate だけを送出設定へ反映する', () => {
    expect(resolveScreenShareVideoSettingsForSearch('?video-profile=realtime&video-max-bitrate=1200000')).toMatchObject({
      ...REALTIME_SCREEN_SHARE_VIDEO_SETTINGS,
      maxBitrate: 1_200_000,
    });
    expect(resolveScreenShareVideoSettingsForSearch('?video-profile=realtime&video-max-bitrate=2000000')).toMatchObject({
      ...REALTIME_SCREEN_SHARE_VIDEO_SETTINGS,
      maxBitrate: 2_000_000,
    });
  });

  test('不正な realtime query は候補全体を既定設定へ戻す', () => {
    for (const search of [
      '?video-profile=realtime&video-max-bitrate=3000000',
      '?video-profile=realtime&video-max-bitrate=',
      '?video-profile=realtime&video-max-bitrate=1200000&video-max-bitrate=2000000',
      '?video-profile=REALTIME',
      '?video-profile=realtime&video-profile=realtime',
      '?video-profile=realtime&video-max-bitrate=2000000&stream-profile=mp3-beta',
    ]) {
      expect(resolveScreenShareVideoSettingsForSearch(search)).toEqual(SCREEN_SHARE_VIDEO_SETTINGS);
    }
  });
});
