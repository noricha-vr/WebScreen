import { describe, expect, test } from 'bun:test';

import {
  configureRawAudioTracks,
  displayAudioConstraintForRawProfile,
  isRawAudioProfileForSearch,
} from '../../src/lib/ui/audio-profile';

describe('raw 音声プロファイル', () => {
  test('audio-profile=raw が重複なく1個の時だけ有効にする', () => {
    expect(isRawAudioProfileForSearch('?audio-profile=raw')).toBe(true);
    expect(isRawAudioProfileForSearch('')).toBe(false);
    expect(isRawAudioProfileForSearch('?audio-profile=aac')).toBe(false);
    expect(isRawAudioProfileForSearch('?audio-profile=raw&audio-profile=raw')).toBe(false);
    expect(isRawAudioProfileForSearch('?audio-profile=raw&audio-profile=aac')).toBe(false);
    expect(isRawAudioProfileForSearch('?audio-profile=')).toBe(false);
    expect(isRawAudioProfileForSearch('?audio-profile=RAW')).toBe(false);
  });

  test('有効時だけブラウザの音声処理を無効化する制約を返す', () => {
    expect(displayAudioConstraintForRawProfile(false)).toBe(true);
    expect(displayAudioConstraintForRawProfile(true)).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  test('raw 音声トラックを music として送出し、取得設定を記録する', () => {
    const previousInfo = console.info;
    const events: unknown[][] = [];
    const track = {
      contentHint: '',
      getSettings: () => ({
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48_000,
      }),
    } as unknown as MediaStreamTrack;
    console.info = (...values: unknown[]) => { events.push(values); };
    try {
      configureRawAudioTracks({ getAudioTracks: () => [track] } as unknown as MediaStream);

      expect(track.contentHint).toBe('music');
      expect(events).toEqual([['raw_audio_capture_settings', {
        event: 'raw_audio_capture_settings',
        channelCount: 2,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48_000,
      }]]);
    } finally {
      console.info = previousInfo;
    }
  });
});
