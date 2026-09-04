import { MAX_RECORDING_BYTES, ScreenRecorder, type MediaRecorderConstructor, type RecordingPicker } from './recorder';
import type { ScreenShareView } from './view';

/**
 * 未ダウンロードの録画が Blob としてタブに残る合計の上限。
 * File System Access で直接ディスクへ書いた録画は含まない（メモリを抱えないため）。
 */
export const RECORDING_TOTAL_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

/** 録画に必要な外部境界。テストでは MediaRecorder とファイル選択を差し替える。 */
export interface RecordingDependencies {
  MediaRecorder?: MediaRecorderConstructor | null;
  pickRecordingFile?: RecordingPicker;
  now: () => number;
  /** 1 本の録画をメモリに蓄積できる上限（既定は MAX_RECORDING_BYTES）。 */
  maxRecordingBytes?: number;
  /** 未ダウンロードの Blob 合計の上限（既定は RECORDING_TOTAL_LIMIT_BYTES）。 */
  totalRecordingLimitBytes?: number;
}

/**
 * 録画ボタンと一覧の調停役。MediaStream は配信 session から借用するだけで所有しないので、
 * ここでは track を止めない（停止は配信側の closeLocal に任せる）。
 */
export class RecordingController {
  private readonly recorder: ScreenRecorder;
  private readonly maxBytes: number;
  private readonly totalLimitBytes: number;
  private count = 0;

  constructor(
    private readonly view: ScreenShareView,
    deps: RecordingDependencies
  ) {
    this.maxBytes = deps.maxRecordingBytes ?? MAX_RECORDING_BYTES;
    this.totalLimitBytes = deps.totalRecordingLimitBytes ?? RECORDING_TOTAL_LIMIT_BYTES;
    this.recorder = new ScreenRecorder({
      MediaRecorder: deps.MediaRecorder === undefined ? browserMediaRecorder() : deps.MediaRecorder,
      pickFile: deps.pickRecordingFile ?? browserRecordingPicker(),
      now: deps.now,
      maxBytes: this.maxBytes,
      fileTypeDescription: view.recordingFileTypeDescription(),
      onElapsed: (seconds) => this.view.setRecordingElapsed(seconds),
      onStateChange: (state) => this.view.setRecordingState(state),
      onError: (error) => this.view.setRecordingError(error.code),
      // 完成した録画の受け口はここだけ。停止経路（外部 stop・サイズ上限・エラー）を問わず一覧へ 1 件積む。
      onRecordingComplete: (recording) => this.view.addRecording(recording, ++this.count),
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
    // 未ダウンロードの Blob はタブが抱え続ける。次の録画が上限に達しうるなら開始しない。
    if (this.view.pendingRecordingBytes() + this.maxBytes > this.totalLimitBytes) {
      return this.view.setRecordingError('totalLimit');
    }
    await this.recorder.start(media, this.view.recordingFilenameBase(this.count + 1));
  }

  /** 録画を止め、完了（一覧への追加まで）を待つ。同時に呼ばれても二重に積まない。 */
  stop(): Promise<void> {
    return this.recorder.stop();
  }
}

function browserMediaRecorder(): MediaRecorderConstructor | null {
  return typeof MediaRecorder === 'undefined' ? null : MediaRecorder as unknown as MediaRecorderConstructor;
}

function browserRecordingPicker(): RecordingPicker | undefined {
  return (globalThis as unknown as { showSaveFilePicker?: RecordingPicker }).showSaveFilePicker;
}
