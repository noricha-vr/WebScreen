import { describe, expect, test } from 'bun:test';

import {
  buildStreamDiagnosticSnapshot,
  classifyStreamFailure,
} from '../../src/lib/ui/screen-share/diagnostics';
import type { VideoPublishStats } from '../../src/lib/ui/whip-publisher';
import type { StreamHealthResponse } from '../../src/lib/contracts/streams';

describe('classifyStreamFailure', () => {
  test('画面選択の拒否は streamDisplayDenied', () => {
    expect(classifyStreamFailure({ kind: 'displayDenied', stats: null, health: null }))
      .toBe('streamDisplayDenied');
  });

  test('WHIP publish 失敗は streamPublishFailed（stats を見ない）', () => {
    const stats: VideoPublishStats = { bytesSent: 0, framesEncoded: 0 };
    expect(classifyStreamFailure({ kind: 'publishFailed', stats, health: null }))
      .toBe('streamPublishFailed');
  });

  test('healthTimeout で bytesSent===0 は streamNoVideo（H.264 未生成）', () => {
    const stats: VideoPublishStats = { bytesSent: 0, framesEncoded: undefined };
    expect(classifyStreamFailure({ kind: 'healthTimeout', stats, health: null }))
      .toBe('streamNoVideo');
  });

  test('healthTimeout で bytesSent/framesEncoded 両方 undefined は streamStatsUnavailable', () => {
    const stats: VideoPublishStats = { bytesSent: undefined, framesEncoded: undefined };
    expect(classifyStreamFailure({ kind: 'healthTimeout', stats, health: null }))
      .toBe('streamStatsUnavailable');
  });

  test('healthTimeout で stats が取れない（null）も streamStatsUnavailable', () => {
    expect(classifyStreamFailure({ kind: 'healthTimeout', stats: null, health: null }))
      .toBe('streamStatsUnavailable');
  });

  test('healthTimeout で bytesSent>0 は streamHealthTimeout（送れているが health 未達）', () => {
    const stats: VideoPublishStats = { bytesSent: 4096, framesEncoded: undefined };
    expect(classifyStreamFailure({ kind: 'healthTimeout', stats, health: null }))
      .toBe('streamHealthTimeout');
  });
});

describe('buildStreamDiagnosticSnapshot', () => {
  const health: StreamHealthResponse = {
    state: 'starting',
    ingressBytes: 10,
    egressBytes: 0,
    audioDetected: null,
  };

  test('12 文字の stream id を必ず含める', () => {
    const snapshot = buildStreamDiagnosticSnapshot({
      streamId: 'Ab12Cd34Ef56',
      at: '2026-09-03T00:00:00.000Z',
      userAgent: 'test-agent',
      displaySurface: 'monitor',
      video: { width: 1920, height: 1080, frameRate: 30 },
      stats: { bytesSent: 0, framesEncoded: undefined },
      health,
      failureCode: 'streamNoVideo',
    });
    expect(snapshot.streamId).toBe('Ab12Cd34Ef56');
    expect((snapshot.streamId as string).length).toBe(12);
    expect(snapshot.failureCode).toBe('streamNoVideo');
    expect(JSON.parse(JSON.stringify(snapshot))).toBeDefined();
  });

  test('欠落した stats を 0 に潰さず undefined のまま残す', () => {
    const snapshot = buildStreamDiagnosticSnapshot({
      streamId: 'Ab12Cd34Ef56',
      at: '2026-09-03T00:00:00.000Z',
      userAgent: 'test-agent',
      displaySurface: null,
      video: null,
      stats: { bytesSent: 4096, framesEncoded: undefined },
      health: null,
      failureCode: 'streamHealthTimeout',
    });
    expect(snapshot.stats).toEqual({ bytesSent: 4096, framesEncoded: undefined });
    expect(snapshot.video).toBeNull();
    expect(snapshot.health).toBeNull();
  });

  test('画面選択拒否では stream id が null（配信が生まれていない）', () => {
    const snapshot = buildStreamDiagnosticSnapshot({
      streamId: null,
      at: '2026-09-03T00:00:00.000Z',
      userAgent: 'test-agent',
      displaySurface: null,
      video: null,
      stats: null,
      health: null,
      failureCode: 'streamDisplayDenied',
    });
    expect(snapshot.streamId).toBeNull();
    expect(Object.keys(snapshot)).toContain('streamId');
  });
});
