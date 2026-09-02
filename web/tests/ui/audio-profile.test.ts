import { describe, expect, test } from 'bun:test';

import {
  configureCaptureAudioTracks,
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
      configureCaptureAudioTracks({ getAudioTracks: () => [track] } as unknown as MediaStream, true);

      expect(track.contentHint).toBe('music');
      expect(events).toEqual([['audio_capture_settings', {
        event: 'audio_capture_settings',
        profile: 'raw',
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

  test('既定経路でも取得設定を記録するが contentHint は変えない', () => {
    const previousInfo = console.info;
    const events: unknown[][] = [];
    const track = {
      contentHint: '',
      getSettings: () => ({ channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48_000 }),
    } as unknown as MediaStreamTrack;
    console.info = (...values: unknown[]) => { events.push(values); };
    try {
      configureCaptureAudioTracks({ getAudioTracks: () => [track] } as unknown as MediaStream, false);

      expect(track.contentHint).toBe('');
      expect(events).toEqual([['audio_capture_settings', {
        event: 'audio_capture_settings',
        profile: 'default',
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 48_000,
      }]]);
    } finally {
      console.info = previousInfo;
    }
  });
});
