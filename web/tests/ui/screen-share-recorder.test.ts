import { describe, expect, jest, test } from 'bun:test';

import {
  MAX_RECORDING_BYTES,
  ScreenRecorder,
  type LocalRecording,
  type MediaRecorderConstructor,
  type RecorderError,
  type RecorderState,
  type RecordingFileHandle,
  type RecordingWritable,
} from '../../src/lib/ui/screen-share/recorder';

describe('ローカル録画のステートマシン', () => {
  test('開始から停止まで idle → recording → stopping → idle を一度ずつ通る', async () => {
    const harness = recorder();

    await harness.recorder.start(harness.stream, '録画 1');
    expect(harness.recorder.currentState).toBe('recording');
    harness.instance().emit(1024);
    await harness.recorder.stop();

    expect(harness.states).toEqual(['recording', 'stopping', 'idle']);
    expect(harness.recorder.currentState).toBe('idle');
    expect(harness.completed).toMatchObject([{ filename: '録画 1.webm', sizeBytes: 1024 }]);
  });

  test('配信の track は借用するだけで停止しない', async () => {
    const harness = recorder();

    await harness.recorder.start(harness.stream, '録画 1');
    await harness.recorder.stop();

    expect(harness.instance().stream).toBe(harness.stream);
    expect(harness.stoppedTracks).toBe(0);
  });

  test('mp4 が使える環境では mp4、無ければ webm を選ぶ', async () => {
    const mp4 = recorder({ supported: ['video/mp4', 'video/webm;codecs=h264', 'video/webm'] });
    await mp4.recorder.start(mp4.stream, '録画 1');
    expect(mp4.instance().mimeType).toBe('video/mp4');
    await mp4.recorder.stop();
    expect(mp4.completed[0]?.filename).toBe('録画 1.mp4');

    const h264 = recorder({ supported: ['video/webm;codecs=h264', 'video/webm'] });
    await h264.recorder.start(h264.stream, '録画 1');
    expect(h264.instance().mimeType).toBe('video/webm;codecs=h264');
    await h264.recorder.stop();
    expect(h264.completed[0]?.filename).toBe('録画 1.webm');
  });

  test('1 秒ごとのチャンクを受け取り、経過秒を通知する', async () => {
    const timers = installFakeIntervals();
    try {
      const harness = recorder();
      await harness.recorder.start(harness.stream, '録画 1');

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

    await harness.recorder.start(harness.stream, '録画 1');

    expect(harness.errors).toEqual([{ code: 'unsupported' }]);
    expect(harness.created).toBe(0);
    expect(harness.recorder.currentState).toBe('idle');
  });

  test('MediaRecorder 自体が無い環境も unsupported として扱う', async () => {
    const errors: RecorderError[] = [];
    const instance = new ScreenRecorder({ MediaRecorder: null, onError: (error) => errors.push(error) });

    await instance.start(fakeStream().stream, '録画 1');

    expect(errors).toEqual([{ code: 'unsupported' }]);
    expect(instance.currentState).toBe('idle');
  });

  test('保存先の選択に失敗したら writeFailed を通知し、録画を始めない', async () => {
    const harness = recorder({ pickFile: () => Promise.reject(new Error('picker denied')) });

    await harness.recorder.start(harness.stream, '録画 1');

    expect(harness.errors.map((error) => error.code)).toEqual(['writeFailed']);
    expect(harness.created).toBe(0);
    expect(harness.recorder.currentState).toBe('idle');
  });

  test('ファイルの close に失敗したら writeFailed を通知し、録画を残さない', async () => {
    const file = fakeFile({ closeError: new Error('disk full') });
    const harness = recorder({ pickFile: () => Promise.resolve(file.handle) });

    await harness.recorder.start(harness.stream, '録画 1');
    harness.instance().emit(64);
    await harness.recorder.stop();

    expect(harness.completed).toEqual([]);
    expect(harness.errors.map((error) => error.code)).toEqual(['writeFailed']);
  });

  test('開始の例外でも完了は 1 度だけで、ファイルを二重に閉じない', async () => {
    const file = fakeFile();
    const harness = recorder({
      pickFile: () => Promise.resolve(file.handle),
      startError: new Error('start failed'),
    });

    await harness.recorder.start(harness.stream, '録画 1');

    // 書き込み失敗として終わるので、既存ファイルへ反映せず破棄する。
    expect(file.closed).toBe(0);
    expect(file.aborted).toBe(1);
    expect(harness.states).toEqual(['recording', 'stopping', 'idle']);
    expect(harness.errors.map((error) => error.code)).toEqual(['writeFailed']);
    expect(harness.completed).toEqual([]);
  });

  test('MediaRecorder の onerror は録画を止めるが、配信は止めない', async () => {
    const harness = recorder();

    await harness.recorder.start(harness.stream, '録画 1');
    harness.instance().onerror?.(new Event('error'));
    await harness.recorder.stop();

    expect(harness.errors.map((error) => error.code)).toEqual(['writeFailed']);
    expect(harness.recorder.currentState).toBe('idle');
    expect(harness.stoppedTracks).toBe(0);
  });

  test('メモリ蓄積が上限に達したら自動停止し、そこまでの録画を完了通知で渡す', async () => {
    const harness = recorder({ maxBytes: 100 });

    await harness.recorder.start(harness.stream, '録画 1');
    harness.instance().emit(80);
    // 上限による自動停止。外から stop() を呼ばなくても完了通知が 1 件届く。
    harness.instance().emit(80);
    await settle();

    expect(harness.errors).toEqual([{ code: 'sizeLimit' }]);
    expect(harness.completed.length).toBe(1);
    expect(harness.completed[0]?.sizeBytes).toBe(80);
    expect(harness.completed[0]?.blob?.size).toBe(80);
    expect(harness.recorder.currentState).toBe('idle');
  });

  test('上限の既定値は 1 GB', () => {
    expect(MAX_RECORDING_BYTES).toBe(1024 * 1024 * 1024);
  });
});

describe('ローカル録画の保存先', () => {
  test('showSaveFilePicker がある環境はチャンクを逐次書き込み、Blob を抱えない', async () => {
    const file = fakeFile();
    const harness = recorder({ pickFile: () => Promise.resolve(file.handle) });

    await harness.recorder.start(harness.stream, '録画 1');
    harness.instance().emit(32);
    harness.instance().emit(16);
    await harness.recorder.stop();

    expect(file.written).toEqual([32, 16]);
    expect(file.closed).toBe(1);
    expect(harness.completed[0]).toMatchObject({ sizeBytes: 48, blob: null });
    expect(harness.completed[0]?.fileHandle).toBe(file.handle);
  });

  test('保存ダイアログのファイル種別は辞書から渡した文言を使う', async () => {
    const file = fakeFile();
    const descriptions: string[] = [];
    const harness = recorder({
      fileTypeDescription: '動画',
      pickFile: (options) => {
        for (const type of (options as { types: Array<{ description: string }> }).types) {
          descriptions.push(type.description);
        }
        return Promise.resolve(file.handle);
      },
    });

    await harness.recorder.start(harness.stream, '録画 1');
    await harness.recorder.stop();

    expect(descriptions).toEqual(['動画']);
  });

  test('保存先を選んでいる間の再入と、選択中の配信停止では録画を始めない', async () => {
    const picks: Array<(handle: RecordingFileHandle) => void> = [];
    const file = fakeFile();
    const harness = recorder({
      pickFile: () => new Promise((resolve) => { picks.push(resolve); }),
    });

    const first = harness.recorder.start(harness.stream, '録画 1');
    const second = harness.recorder.start(harness.stream, '録画 2');
    expect(picks.length).toBe(1);
    expect(harness.recorder.isActive).toBe(true);

    // 選択ダイアログを開いたまま配信が終わるケース。
    await harness.recorder.stop();
    picks[0]!(file.handle);
    await first;
    await second;

    expect(harness.completed).toEqual([]);
    expect(harness.created).toBe(0);
    // 中断済みなら writable を作らない（作って閉じるとユーザーが選んだ既存ファイルを空にする）。
    expect(file.opened).toBe(0);
    expect(file.closed).toBe(0);
    expect(file.aborted).toBe(0);
    expect(harness.recorder.currentState).toBe('idle');
    expect(harness.recorder.isActive).toBe(false);
  });
});

describe('選んだファイルの保護', () => {
  test('書き込みに失敗したら abort で変更を捨て、close しない', async () => {
    const file = fakeFile({ writeError: new Error('disk full') });
    const harness = recorder({ pickFile: () => Promise.resolve(file.handle) });

    await harness.recorder.start(harness.stream, '録画 1');
    harness.instance().emit(64);
    await harness.recorder.stop();

    expect(file.aborted).toBe(1);
    expect(file.closed).toBe(0);
    expect(harness.errors.map((error) => error.code)).toEqual(['writeFailed']);
    expect(harness.completed).toEqual([]);
  });

  test('createWritable の待機中に配信が終わったら、開いた writable を abort する', async () => {
    const opens: Array<(writable: RecordingWritable) => void> = [];
    const state = { closed: 0, aborted: 0 };
    const handle: RecordingFileHandle = {
      createWritable: () => new Promise((resolve) => { opens.push(resolve); }),
    };
    const harness = recorder({ pickFile: () => Promise.resolve(handle) });

    const started = harness.recorder.start(harness.stream, '録画 1');
    await settle();
    expect(opens.length).toBe(1);

    await harness.recorder.stop();
    opens[0]!({
      write: async () => undefined,
      close: async () => { state.closed += 1; },
      abort: async () => { state.aborted += 1; },
    });
    await started;

    expect(state).toEqual({ closed: 0, aborted: 1 });
    expect(harness.created).toBe(0);
    expect(harness.completed).toEqual([]);
  });
});

describe('ローカル録画の多重停止', () => {
  test('同時に停止しても MediaRecorder は一度だけ止め、完了通知も 1 件だけ出す', async () => {
    const harness = recorder();

    await harness.recorder.start(harness.stream, '録画 1');
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
  pickFile?: (options: unknown) => Promise<RecordingFileHandle>;
  maxBytes?: number;
  fileTypeDescription?: string;
  startError?: Error;
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
      ...(options.pickFile ? { pickFile: options.pickFile as never } : {}),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      now: () => now,
      ...(options.fileTypeDescription === undefined
        ? {}
        : { fileTypeDescription: options.fileTypeDescription }),
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

function fakeFile(options: { closeError?: Error; writeError?: Error } = {}): {
  handle: RecordingFileHandle;
  written: number[];
  closed: number;
  aborted: number;
  opened: number;
} {
  const state = { written: [] as number[], closed: 0, aborted: 0, opened: 0 };
  const writable: RecordingWritable = {
    write: async (data) => {
      if (options.writeError) throw options.writeError;
      state.written.push(data.size);
    },
    close: async () => {
      state.closed += 1;
      if (options.closeError) throw options.closeError;
    },
    abort: async () => { state.aborted += 1; },
  };
  return {
    handle: {
      createWritable: async () => {
        state.opened += 1;
        return writable;
      },
    },
    get written(): number[] { return state.written; },
    get closed(): number { return state.closed; },
    get aborted(): number { return state.aborted; },
    // createWritable の呼び出し回数。呼んだ時点で対象ファイルへ触れる権利を握る。
    get opened(): number { return state.opened; },
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
