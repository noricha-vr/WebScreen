import { describe, expect, jest, test } from 'bun:test';

import {
  MAX_RECORDING_BYTES,
  ScreenRecorder,
  type LocalRecording,
  type MediaRecorderConstructor,
  type RecorderError,
  type RecorderState,
} from '../../src/lib/ui/screen-share/recorder';

describe('ローカル録画のステートマシン', () => {
  test('開始から停止まで idle → recording → stopping → idle を一度ずつ通る', async () => {
    const harness = recorder();

    harness.recorder.start(harness.stream, '録画 1');
    expect(harness.recorder.currentState).toBe('recording');
    harness.instance().emit(1024);
    await harness.recorder.stop();

    expect(harness.states).toEqual(['recording', 'stopping', 'idle']);
    expect(harness.recorder.currentState).toBe('idle');
    expect(harness.completed).toMatchObject([{ filename: '録画 1.webm', sizeBytes: 1024 }]);
    expect(harness.completed[0]?.blob.size).toBe(1024);
  });

  test('配信の track は借用するだけで停止しない', async () => {
    const harness = recorder();

    harness.recorder.start(harness.stream, '録画 1');
    await harness.recorder.stop();

    expect(harness.instance().stream).toBe(harness.stream);
    expect(harness.stoppedTracks).toBe(0);
  });

  test('mp4 が使える環境では mp4、無ければ webm を選ぶ', async () => {
    const mp4 = recorder({ supported: ['video/mp4', 'video/webm;codecs=h264', 'video/webm'] });
    mp4.recorder.start(mp4.stream, '録画 1');
    expect(mp4.instance().mimeType).toBe('video/mp4');
    await mp4.recorder.stop();
    expect(mp4.completed[0]?.filename).toBe('録画 1.mp4');

    const h264 = recorder({ supported: ['video/webm;codecs=h264', 'video/webm'] });
    h264.recorder.start(h264.stream, '録画 1');
    expect(h264.instance().mimeType).toBe('video/webm;codecs=h264');
    await h264.recorder.stop();
    expect(h264.completed[0]?.filename).toBe('録画 1.webm');
  });

  test('1 秒ごとのチャンクを受け取り、経過秒を通知する', async () => {
    const timers = installFakeIntervals();
    try {
      const harness = recorder();
      harness.recorder.start(harness.stream, '録画 1');

      expect(harness.instance().timeslice).toBe(1000);
      expect(harness.elapsed).toEqual([0]);
      harness.advance(2000);
      timers.tick(1000);
      expect(harness.elapsed).toEqual([0, 2]);

      harness.advance(1000);
      await harness.recorder.stop();
      // 停止で interval を解除するので、以降の tick は無い。
      expect(timers.count()).toBe(0);
    } finally {
      timers.restore();
    }
  });
});

describe('ローカル録画の失敗', () => {
  test('対応する動画形式が無ければ unsupported を通知して開始しない', async () => {
    const harness = recorder({ supported: [] });

    harness.recorder.start(harness.stream, '録画 1');

    expect(harness.errors).toEqual([{ code: 'unsupported' }]);
    expect(harness.created).toBe(0);
    expect(harness.recorder.currentState).toBe('idle');
  });

  test('MediaRecorder 自体が無い環境も unsupported として扱う', async () => {
    const errors: RecorderError[] = [];
    const instance = new ScreenRecorder({ MediaRecorder: null, onError: (error) => errors.push(error) });

    instance.start(fakeStream().stream, '録画 1');

    expect(errors).toEqual([{ code: 'unsupported' }]);
    expect(instance.currentState).toBe('idle');
  });

  test('開始の例外は writeFailed を 1 度だけ通知し、録画を残さない', async () => {
    const harness = recorder({ startError: new Error('start failed') });

    harness.recorder.start(harness.stream, '録画 1');

    expect(harness.states).toEqual(['recording', 'stopping', 'idle']);
    expect(harness.errors.map((error) => error.code)).toEqual(['writeFailed']);
    expect(harness.completed).toEqual([]);
  });

  test('MediaRecorder を作れなくても停止の待ち合わせは解ける', async () => {
    const harness = recorder({ constructError: new Error('construct failed') });

    harness.recorder.start(harness.stream, '録画 1');
    // ここで待ちが解けないと、配信停止が録画の完了待ちで止まる。
    await harness.recorder.stop();

    expect(harness.errors.map((error) => error.code)).toEqual(['writeFailed']);
    expect(harness.completed).toEqual([]);
    expect(harness.recorder.currentState).toBe('idle');
  });

  test('MediaRecorder の onerror は録画を止めるが、配信は止めない', async () => {
    const harness = recorder();

    harness.recorder.start(harness.stream, '録画 1');
    harness.instance().onerror?.(new Event('error'));
    await harness.recorder.stop();

    expect(harness.errors.map((error) => error.code)).toEqual(['writeFailed']);
    expect(harness.recorder.currentState).toBe('idle');
    expect(harness.stoppedTracks).toBe(0);
  });

  test('メモリ蓄積が上限に達したら自動停止し、そこまでの録画を完了通知で渡す', async () => {
    const harness = recorder({ maxBytes: 100 });

    harness.recorder.start(harness.stream, '録画 1');
    harness.instance().emit(80);
    // 上限による自動停止。外から stop() を呼ばなくても完了通知が 1 件届く。
    harness.instance().emit(80);
    await settle();

    expect(harness.errors).toEqual([{ code: 'sizeLimit' }]);
    expect(harness.completed.length).toBe(1);
    expect(harness.completed[0]?.sizeBytes).toBe(80);
    expect(harness.completed[0]?.blob.size).toBe(80);
    expect(harness.recorder.currentState).toBe('idle');
  });

  test('上限の既定値は 1 GB', () => {
    expect(MAX_RECORDING_BYTES).toBe(1024 * 1024 * 1024);
  });
});

describe('ローカル録画の多重停止', () => {
  test('同時に停止しても MediaRecorder は一度だけ止め、完了通知も 1 件だけ出す', async () => {
    const harness = recorder();

    harness.recorder.start(harness.stream, '録画 1');
    harness.instance().emit(8);
    await Promise.all([harness.recorder.stop(), harness.recorder.stop()]);

    expect(harness.instance().stopCalls).toBe(1);
    expect(harness.completed.length).toBe(1);
    expect(harness.states.filter((state) => state === 'stopping').length).toBe(1);
  });

  test('録画していない時の停止は完了通知を出さない', async () => {
    const harness = recorder();

    await harness.recorder.stop();
    expect(harness.completed).toEqual([]);
    expect(harness.states).toEqual([]);
  });

  test('停止要求が start の直後に来ても、開始済みなら 1 件として完了する', async () => {
    const harness = recorder();

    // start は同期で走り切るので、await を挟まない停止でも「開始済みの録画」を必ず止められる。
    harness.recorder.start(harness.stream, '録画 1');
    harness.instance().emit(256);
    const stopped = harness.recorder.stop();
    expect(harness.recorder.currentState).toBe('idle');
    await stopped;

    expect(harness.created).toBe(1);
    expect(harness.instance().stopCalls).toBe(1);
    expect(harness.completed).toMatchObject([{ sizeBytes: 256 }]);
  });
});

interface RecorderHarness {
  recorder: ScreenRecorder;
  stream: MediaStream;
  states: RecorderState[];
  errors: RecorderError[];
  elapsed: number[];
  completed: LocalRecording[];
  created: number;
  stoppedTracks: number;
  instance: () => FakeMediaRecorder;
  advance: (ms: number) => void;
}

function recorder(options: {
  supported?: string[];
  maxBytes?: number;
  startError?: Error;
  constructError?: Error;
} = {}): RecorderHarness {
  const instances: FakeMediaRecorder[] = [];
  const supported = options.supported ?? ['video/webm'];
  const media = fakeStream();
  let now = Date.parse('2026-09-01T00:00:00.000Z');
  class Constructor extends FakeMediaRecorder {
    static isTypeSupported(mimeType: string): boolean {
      return supported.includes(mimeType);
    }
    constructor(stream: MediaStream, init?: MediaRecorderOptions) {
      super(stream, init);
      if (options.constructError) throw options.constructError;
      instances.push(this);
    }
    override start(timeslice?: number): void {
      if (options.startError) throw options.startError;
      super.start(timeslice);
    }
  }
  const harness: RecorderHarness = {
    recorder: new ScreenRecorder({
      MediaRecorder: Constructor as unknown as MediaRecorderConstructor,
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      now: () => now,
      onStateChange: (state) => harness.states.push(state),
      onError: (error) => harness.errors.push({ code: error.code }),
      onElapsed: (seconds) => harness.elapsed.push(seconds),
      onRecordingComplete: (recording) => harness.completed.push(recording),
    }),
    stream: media.stream,
    states: [],
    errors: [],
    elapsed: [],
    completed: [],
    get created(): number { return instances.length; },
    get stoppedTracks(): number { return media.stopped; },
    instance: () => instances[instances.length - 1]!,
    advance: (ms) => { now += ms; },
  };
  return harness;
}

class FakeMediaRecorder {
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType: string;
  timeslice: number | null = null;
  stopCalls = 0;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: (() => void) | null = null;

  constructor(readonly stream: MediaStream, init?: MediaRecorderOptions) {
    this.mimeType = init?.mimeType ?? '';
  }

  start(timeslice?: number): void {
    this.state = 'recording';
    this.timeslice = timeslice ?? null;
  }

  stop(): void {
    this.stopCalls += 1;
    this.state = 'inactive';
    this.onstop?.();
  }

  emit(size: number): void {
    this.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) } as BlobEvent);
  }
}

function fakeStream(): { stream: MediaStream; stopped: number } {
  const state = { stopped: 0 };
  const track = { stop: () => { state.stopped += 1; }, addEventListener: () => undefined };
  return {
    stream: { getTracks: () => [track], getVideoTracks: () => [track], getAudioTracks: () => [] } as unknown as MediaStream,
    get stopped(): number { return state.stopped; },
  };
}

/** 自動停止のように await 先が無い完了処理を待つ（microtask を数回流す）。 */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
}

function installFakeIntervals(): { tick: (delay: number) => void; count: () => number; restore: () => void } {
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  let nextId = 1;
  const setIntervalMock = jest.spyOn(globalThis, 'setInterval').mockImplementation((
    (callback: () => void, delay = 0) => {
      const id = nextId;
      nextId += 1;
      intervals.set(id, { callback, delay });
      return id as unknown as ReturnType<typeof setInterval>;
    }
  ) as typeof setInterval);
  const clearIntervalMock = jest.spyOn(globalThis, 'clearInterval').mockImplementation((
    (id: ReturnType<typeof setInterval>) => { intervals.delete(Number(id)); }
  ) as typeof clearInterval);

  return {
    tick(delay) {
      const interval = [...intervals.values()].find((candidate) => candidate.delay === delay);
      if (!interval) throw new Error(`Expected a ${delay} ms interval`);
      interval.callback();
    },
    count: () => intervals.size,
    restore() {
      clearIntervalMock.mockRestore();
      setIntervalMock.mockRestore();
    },
  };
}
