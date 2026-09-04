import { ScreenRecorder, type MediaRecorderConstructor, type RecordingPicker } from './recorder';
import type { ScreenShareView } from './view';

/** 録画に必要な外部境界。テストでは MediaRecorder とファイル選択を差し替える。 */
export interface RecordingDependencies {
  MediaRecorder?: MediaRecorderConstructor | null;
  pickRecordingFile?: RecordingPicker;
  now: () => number;
}

/**
 * 録画ボタンと一覧の調停役。MediaStream は配信 session から借用するだけで所有しないので、
 * ここでは track を止めない（停止は配信側の closeLocal に任せる）。
 */
export class RecordingController {
  private readonly recorder: ScreenRecorder;
  private count = 0;
  private stopTask: Promise<void> | null = null;

  constructor(
    private readonly view: ScreenShareView,
    deps: RecordingDependencies
  ) {
    this.recorder = new ScreenRecorder({
      MediaRecorder: deps.MediaRecorder === undefined ? browserMediaRecorder() : deps.MediaRecorder,
      pickFile: deps.pickRecordingFile ?? browserRecordingPicker(),
      now: deps.now,
      onElapsed: (seconds) => this.view.setRecordingElapsed(seconds),
      onStateChange: (state) => this.view.setRecordingState(state),
      onError: (error) => this.view.setRecordingError(error.code),
    });
  }

  /** 停止すべき録画を抱えているか（ファイル選択の待機中を含む）。 */
  get isActive(): boolean {
    return this.recorder.isActive;
  }

  /** 録画ボタン。録画中なら停止し、そうでなければ借用した stream で開始する。 */
  async toggle(media: MediaStream): Promise<void> {
    if (this.recorder.currentState === 'recording') return this.stop();
    if (this.recorder.isActive) return;
    this.view.setRecordingError(null);
    await this.recorder.start(media, this.view.recordingFilenameBase(this.count + 1));
  }

  /** 録画を止めて一覧へ 1 件積む。配信停止と同時に呼ばれても二重に積まない。 */
  stop(): Promise<void> {
    this.stopTask ??= this.recorder.stop()
      .then((recording) => {
        if (recording) this.view.addRecording(recording, ++this.count);
      })
      .finally(() => { this.stopTask = null; });
    return this.stopTask;
  }
}

function browserMediaRecorder(): MediaRecorderConstructor | null {
  return typeof MediaRecorder === 'undefined' ? null : MediaRecorder as unknown as MediaRecorderConstructor;
}

function browserRecordingPicker(): RecordingPicker | undefined {
  return (globalThis as unknown as { showSaveFilePicker?: RecordingPicker }).showSaveFilePicker;
}
