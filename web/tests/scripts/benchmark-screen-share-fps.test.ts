import { describe, expect, test } from 'bun:test';

import {
  createCleanupStack,
  createSignalHandler,
  diffVideoStats,
  parseArgs,
  selectPrimaryH264VideoOutbound,
  snapshotPrimaryVideoStats,
  type StatsRow,
} from '../../scripts/benchmark-screen-share-fps-core';
import {
  finalizeRun,
  withRunDeadline,
  type DeadlineTimers,
} from '../../scripts/benchmark-screen-share-fps-run';

function deadlineHarness(): {
  timers: DeadlineTimers;
  fire(): boolean;
  cancelled(): boolean;
  scheduledMilliseconds(): number;
} {
  const handle = {};
  let callback: (() => void) | undefined;
  let wasCancelled = false;
  let milliseconds = -1;
  return {
    timers: {
      schedule(nextCallback, nextMilliseconds) {
        callback = nextCallback;
        milliseconds = nextMilliseconds;
        return handle;
      },
      cancel(nextHandle) {
        expect(nextHandle).toBe(handle);
        wasCancelled = true;
        callback = undefined;
      },
    },
    fire() {
      if (!callback) return false;
      callback();
      return true;
    },
    cancelled: () => wasCancelled,
    scheduledMilliseconds: () => milliseconds,
  };
}

function videoRows(overrides: Partial<StatsRow> = {}): StatsRow[] {
  return [
    { id: 'codec-h264', type: 'codec', mimeType: 'video/H264' },
    { id: 'codec-rtx', type: 'codec', mimeType: 'video/rtx' },
    {
      id: 'outbound-primary', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264',
      framesEncoded: 10, keyFramesEncoded: 2, bytesSent: 1_000, qpSum: 300,
      totalEncodeTime: 1.5, framesSent: 10, frameWidth: 1280, frameHeight: 642,
      qualityLimitationReason: 'none', ...overrides,
    },
    {
      id: 'outbound-rtx', type: 'outbound-rtp', kind: 'video', codecId: 'codec-rtx',
      framesEncoded: 0, keyFramesEncoded: 0, bytesSent: 50, qpSum: 0,
      totalEncodeTime: 0, framesSent: 0,
    },
  ];
}

describe('benchmark CLI options', () => {
  test('defaultsはtab・10秒・24→30でsourceなし', () => {
    expect(parseArgs([], {})).toEqual({
      mode: 'tab', durationSeconds: 10, fps: [24, 30], source: null, help: false,
    });
  });

  test('inlineと分離形式を読み、fpsの順序と重複を厳密に保つ', () => {
    expect(parseArgs(['--mode=screen', '--duration', '60', '--fps=30,24,30'], {})).toEqual({
      mode: 'screen', durationSeconds: 60, fps: [30, 24, 30], source: null, help: false,
    });
  });

  test('durationとfpsの上下限を受け付ける', () => {
    expect(parseArgs(['--duration=1', '--fps=1,120'], {}).durationSeconds).toBe(1);
    expect(parseArgs(['--duration=900'], {}).durationSeconds).toBe(900);
  });

  test('範囲外・NaN・未知option・値欠落を拒否する', () => {
    for (const args of [
      ['--duration=0'], ['--duration=901'], ['--duration=NaN'], ['--fps=0'],
      ['--fps=121'], ['--fps=NaN'], ['--unknown'], ['--mode'],
    ]) expect(() => parseArgs(args, {})).toThrow();
  });

  test('tabのsourceをCLI・環境変数とも拒否する', () => {
    expect(() => parseArgs(['--source=Chrome'], {})).toThrow('only valid with --mode screen');
    expect(() => parseArgs([], { SCREEN_CAPTURE_SOURCE: 'Display 1' })).toThrow(
      'only valid with --mode screen'
    );
  });

  test('screenではCLI sourceを環境変数より優先する', () => {
    expect(parseArgs(
      ['--mode', 'screen', '--source', 'Display 2'],
      { SCREEN_CAPTURE_SOURCE: 'Display 1' }
    ).source).toBe('Display 2');
  });
});

describe('H.264 interval stats', () => {
  test('codec参照でRTXを除外しprimary H.264を一意選択する', () => {
    expect(selectPrimaryH264VideoOutbound(videoRows()).outbound.id).toBe('outbound-primary');
  });

  test('不明codec・H.264以外・複数primaryをfail-closedする', () => {
    expect(() => selectPrimaryH264VideoOutbound(videoRows({ codecId: 'missing' }))).toThrow(
      'no known codec'
    );
    const vp8 = videoRows();
    vp8[0]!.mimeType = 'video/VP8';
    expect(() => selectPrimaryH264VideoOutbound(vp8)).toThrow('not H.264');
    const duplicate = videoRows();
    duplicate.push({ ...duplicate[2]!, id: 'outbound-second' });
    expect(() => selectPrimaryH264VideoOutbound(duplicate)).toThrow('expected one');
  });

  test('baseline差分から区間counterとH.264 encoded fpsを返す', () => {
    const start = snapshotPrimaryVideoStats(videoRows());
    const end = snapshotPrimaryVideoStats(videoRows({
      framesEncoded: 310, keyFramesEncoded: 22, bytesSent: 901_000, qpSum: 9_300,
      totalEncodeTime: 31.5, framesSent: 310, frameWidth: 1280, frameHeight: 642,
    }));
    expect(diffVideoStats(start, end, 10_000)).toEqual({
      codecMimeType: 'video/H264', framesEncoded: 300, keyFramesEncoded: 20,
      bytesSent: 900_000, qpSum: 9_000, totalEncodeTime: 30, framesSent: 300,
      encodedFramesPerSecond: 30, frameWidth: 1280, frameHeight: 642,
      qualityLimitationReason: 'none',
    });
  });

  test('counter reset・identity変更・不正elapsedをfail-closedする', () => {
    const start = snapshotPrimaryVideoStats(videoRows());
    const reset = snapshotPrimaryVideoStats(videoRows({ framesEncoded: 9 }));
    expect(() => diffVideoStats(start, reset, 1_000)).toThrow('counter reset');
    const changed = { ...snapshotPrimaryVideoStats(videoRows()), outboundId: 'new-ssrc' };
    expect(() => diffVideoStats(start, changed, 1_000)).toThrow('identity changed');
    expect(() => diffVideoStats(start, start, 0)).toThrow('elapsedMs');
  });

  test('rVFC capture deliveryとH.264 baseline差分を別FPSとして集計する', () => {
    const result = finalizeRun({
      requestedFps: 24, durationSeconds: 10, elapsedMs: 10_000, captureFrames: 240,
      trackSettings: { width: 1280, height: 642, frameRate: 24 },
      baselineStats: videoRows(),
      endStats: videoRows({
        framesEncoded: 210, keyFramesEncoded: 12, bytesSent: 601_000, qpSum: 6_300,
        totalEncodeTime: 21.5, framesSent: 210,
      }),
      keyframeRequests: { attempted: 20, succeeded: 20, error: null },
    }, { width: 1280, height: 720 });
    expect(result.capture.deliveryFramesPerSecond).toBe(24);
    expect(result.h264Encode.encodedFramesPerSecond).toBe(20);
    expect(result.capture.trackSettings).toEqual({ width: 1280, height: 642, frameRate: 24 });
    expect(result.capture.requestedHeightIdeal).toBe(720);
  });
});

describe('run deadline', () => {
  test('成功値を返し、計測時間+猶予で予約したtimerを解除する', async () => {
    const harness = deadlineHarness();
    await expect(withRunDeadline(Promise.resolve('done'), 10, 30_000, harness.timers))
      .resolves.toBe('done');
    expect(harness.scheduledMilliseconds()).toBe(40_000);
    expect(harness.cancelled()).toBeTrue();
    expect(harness.fire()).toBeFalse();
  });

  test('deadline到達時に明確なtimeoutとして拒否する', async () => {
    const harness = deadlineHarness();
    const pending = withRunDeadline(new Promise<never>(() => undefined), 10, 0, harness.timers);
    expect(harness.fire()).toBeTrue();
    await expect(pending).rejects.toThrow('measurement exceeded its deadline');
    expect(harness.cancelled()).toBeTrue();
  });

  test('timeout後の元promise遅延rejectを未処理にしない', async () => {
    const harness = deadlineHarness();
    let rejectOriginal!: (error: Error) => void;
    const original = new Promise<never>((_, reject) => { rejectOriginal = reject; });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown): void => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const pending = withRunDeadline(original, 1, 0, harness.timers);
      harness.fire();
      await expect(pending).rejects.toThrow('measurement exceeded its deadline');
      rejectOriginal(new Error('late source failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('cleanup and signals', () => {
  test('cleanupを逆順かつ冪等に実行する', async () => {
    const calls: number[] = [];
    const cleanup = createCleanupStack();
    cleanup.add(() => { calls.push(1); });
    cleanup.add(async () => { calls.push(2); });
    await Promise.all([cleanup.run(), cleanup.run()]);
    expect(calls).toEqual([2, 1]);
  });

  test('途中で失敗しても全cleanupを実行する', async () => {
    const calls: string[] = [];
    const cleanup = createCleanupStack();
    cleanup.add(() => { calls.push('last'); });
    cleanup.add(() => { calls.push('fail'); throw new Error('boom'); });
    await expect(cleanup.run()).rejects.toBeInstanceOf(AggregateError);
    expect(calls).toEqual(['fail', 'last']);
  });

  test('signal cleanupは一度だけでSIGINT/SIGTERMのexit codeを返す', async () => {
    let cleanupCalls = 0;
    const exits: number[] = [];
    const interrupt = createSignalHandler(async () => { cleanupCalls += 1; }, (code) => exits.push(code));
    await Promise.all([interrupt('SIGINT'), interrupt('SIGINT')]);
    expect(cleanupCalls).toBe(1);
    expect(exits).toEqual([130]);
    const terminate = createSignalHandler(async () => {}, (code) => exits.push(code));
    await terminate('SIGTERM');
    expect(exits.at(-1)).toBe(143);
  });

  test('signal cleanup失敗を報告してexit 1にする', async () => {
    const errors: unknown[] = [];
    const exits: number[] = [];
    const handler = createSignalHandler(
      async () => { throw new Error('cleanup error'); },
      (code) => exits.push(code),
      (error) => errors.push(error)
    );
    await handler('SIGTERM');
    expect(errors).toHaveLength(1);
    expect(exits).toEqual([1]);
  });
});
