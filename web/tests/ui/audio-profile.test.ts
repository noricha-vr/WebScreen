import { describe, expect, test } from 'bun:test';

import {
  configureCaptureAudioTracks,
  displayAudioConstraint,
  resolveAudioProfileForSearch,
} from '../../src/lib/ui/audio-profile';

describe('音声プロファイル', () => {
  test('audio-profile=legacy が重複なく1個の時だけ旧挙動へ戻す', () => {
    expect(resolveAudioProfileForSearch('?audio-profile=legacy')).toBe('legacy');
    expect(resolveAudioProfileForSearch('')).toBe('raw');
    expect(resolveAudioProfileForSearch('?audio-profile=raw')).toBe('raw');
    expect(resolveAudioProfileForSearch('?audio-profile=aac')).toBe('raw');
    expect(resolveAudioProfileForSearch('?audio-profile=legacy&audio-profile=legacy')).toBe('raw');
    expect(resolveAudioProfileForSearch('?audio-profile=legacy&audio-profile=raw')).toBe('raw');
    expect(resolveAudioProfileForSearch('?audio-profile=')).toBe('raw');
    expect(resolveAudioProfileForSearch('?audio-profile=LEGACY')).toBe('raw');
  });

  test('raw だけブラウザの音声処理を無効化する制約を返す', () => {
    expect(displayAudioConstraint('raw')).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    expect(displayAudioConstraint('legacy')).toBe(true);
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
      configureCaptureAudioTracks({ getAudioTracks: () => [track] } as unknown as MediaStream, 'raw');

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

  test('legacy でも取得設定を記録するが contentHint は変えない', () => {
    const previousInfo = console.info;
    const events: unknown[][] = [];
    const track = {
      contentHint: '',
      getSettings: () => ({ channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48_000 }),
    } as unknown as MediaStreamTrack;
    console.info = (...values: unknown[]) => { events.push(values); };
    try {
      configureCaptureAudioTracks({ getAudioTracks: () => [track] } as unknown as MediaStream, 'legacy');

      expect(track.contentHint).toBe('');
      expect(events).toEqual([['audio_capture_settings', {
        event: 'audio_capture_settings',
        profile: 'legacy',
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
