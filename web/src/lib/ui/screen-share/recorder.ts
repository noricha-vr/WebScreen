/** ブラウザ内のローカル録画を開始・停止し、配信の MediaStream を借用する。 */
export const MAX_RECORDING_BYTES = 1024 * 1024 * 1024;
const CHUNK_INTERVAL_MS = 1000;

export type RecorderState = 'idle' | 'recording' | 'stopping';
export type RecorderErrorCode = 'unsupported' | 'writeFailed' | 'sizeLimit';

export interface RecorderError {
  code: RecorderErrorCode;
  cause?: unknown;
}

export interface LocalRecording {
  filename: string;
  extension: string;
  mimeType: string;
  startedAt: number;
  durationSeconds: number;
  sizeBytes: number;
  blob: Blob | null;
  fileHandle: RecordingFileHandle | null;
}

export interface RecordingFileHandle {
  createWritable(): Promise<RecordingWritable>;
  getFile(): Promise<File>;
}

export interface RecordingWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}

export interface RecorderInstance {
  state: 'inactive' | 'recording' | 'paused';
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onstop: (() => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}

export interface MediaRecorderConstructor {
  new (stream: MediaStream, options?: MediaRecorderOptions): RecorderInstance;
  isTypeSupported(mimeType: string): boolean;
}

export interface RecordingPicker {
  (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }): Promise<RecordingFileHandle>;
}

export interface ScreenRecorderOptions {
  MediaRecorder: MediaRecorderConstructor | null;
  pickFile?: RecordingPicker;
  now?: () => number;
  onError?: (error: RecorderError) => void;
  onElapsed?: (seconds: number) => void;
  onStateChange?: (state: RecorderState) => void;
  maxBytes?: number;
}

const MIME_CANDIDATES = [
  { mimeType: 'video/mp4', extension: 'mp4' },
  { mimeType: 'video/webm;codecs=h264', extension: 'webm' },
  { mimeType: 'video/webm', extension: 'webm' },
] as const;

/** MediaRecorder を配信停止から独立して扱うローカル録画機。 */
export class ScreenRecorder {
  private state: RecorderState = 'idle';
  // ファイル選択ダイアログの待機中。state は idle のままなので、再入と中断はこの旗で見る。
  private opening = false;
  private openAborted = false;
  private recorder: RecorderInstance | null = null;
  private writable: RecordingWritable | null = null;
  private fileHandle: RecordingFileHandle | null = null;
  private chunks: Blob[] = [];
  private sizeBytes = 0;
  private startedAt = 0;
  private filename = '';
  private mimeType = '';
  private extension = '';
  private writeChain: Promise<void> = Promise.resolve();
  private completion: Promise<LocalRecording | null> | null = null;
  private resolveCompletion: ((recording: LocalRecording | null) => void) | null = null;
  private failure: RecorderError | null = null;
  private elapsedTimer: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(private readonly options: ScreenRecorderOptions) {}

  get currentState(): RecorderState {
    return this.state;
  }

  /** 停止すべき録画（ファイル選択の待機中も含む）を抱えているか。 */
  get isActive(): boolean {
    return this.opening || this.state !== 'idle';
  }

  /** 選んだ共有 stream を借用して、1 秒単位のチャンク録画を開始する。 */
  async start(stream: MediaStream, filenameBase: string): Promise<void> {
    if (this.isActive) return;
    const candidate = this.selectMimeType();
    if (!candidate || !this.options.MediaRecorder) return this.failStart({ code: 'unsupported' });

    const filename = `${filenameBase}.${candidate.extension}`;
    this.opening = true;
    this.openAborted = false;
    let fileHandle: RecordingFileHandle | null = null;
    let writable: RecordingWritable | null = null;
    try {
      fileHandle = this.options.pickFile
        ? await this.options.pickFile(filePickerOptions(filename, candidate.mimeType))
        : null;
      writable = fileHandle ? await fileHandle.createWritable() : null;
    } catch (error) {
      this.opening = false;
      return this.failStart({ code: 'writeFailed', cause: error });
    }
    // 選択中に配信が終わっていたら、止まった track で MediaRecorder を作らずに閉じる。
    if (this.openAborted) {
      this.opening = false;
      this.openAborted = false;
      await closeQuietly(writable);
      return;
    }
    this.opening = false;

    this.fileHandle = fileHandle;
    this.writable = writable;
    this.reset(filename, candidate.mimeType, candidate.extension);
    try {
      const recorder = new this.options.MediaRecorder(stream, { mimeType: candidate.mimeType });
      this.recorder = recorder;
      recorder.ondataavailable = (event) => this.receiveChunk(event.data);
      recorder.onerror = (event) => this.fail({ code: 'writeFailed', cause: event });
      recorder.onstop = () => void this.complete();
      this.transition('recording');
      recorder.start(CHUNK_INTERVAL_MS);
      this.elapsedTimer = globalThis.setInterval(() => this.emitElapsed(), CHUNK_INTERVAL_MS);
      this.emitElapsed();
    } catch (error) {
      this.fail({ code: 'writeFailed', cause: error });
      await this.complete();
    }
  }

  /** 録画を止め、保存済みの録画情報を返す。同時呼び出しは同じ完了を待つ。 */
  stop(): Promise<LocalRecording | null> {
    if (this.opening) {
      this.openAborted = true;
      return Promise.resolve(null);
    }
    if (this.state === 'idle') return Promise.resolve(null);
    if (this.state === 'stopping') return this.completion ?? Promise.resolve(null);
    this.transition('stopping');
    if (this.recorder?.state !== 'inactive') this.recorder?.stop();
    else void this.complete();
    return this.completion ?? Promise.resolve(null);
  }

  private selectMimeType(): (typeof MIME_CANDIDATES)[number] | null {
    const Constructor = this.options.MediaRecorder;
    return Constructor ? MIME_CANDIDATES.find((candidate) => Constructor.isTypeSupported(candidate.mimeType)) ?? null : null;
  }

  private reset(filename: string, mimeType: string, extension: string): void {
    this.chunks = [];
    this.sizeBytes = 0;
    this.filename = filename;
    this.mimeType = mimeType;
    this.extension = extension;
    this.startedAt = this.now();
    this.failure = null;
    this.writeChain = Promise.resolve();
    this.completion = new Promise((resolve) => { this.resolveCompletion = resolve; });
  }

  private receiveChunk(chunk: Blob): void {
    if (this.state === 'idle' || chunk.size === 0 || this.failure) return;
    // ファイルへ逐次書き込む経路はディスクが上限。メモリ蓄積の時だけ自動停止する。
    if (!this.writable && this.sizeBytes + chunk.size > (this.options.maxBytes ?? MAX_RECORDING_BYTES)) {
      this.fail({ code: 'sizeLimit' });
      return;
    }
    this.sizeBytes += chunk.size;
    if (this.writable) {
      this.writeChain = this.writeChain.then(() => this.writable?.write(chunk) ?? Promise.resolve()).catch((error) => {
        this.fail({ code: 'writeFailed', cause: error });
      });
    } else this.chunks.push(chunk);
  }

  private failStart(error: RecorderError): void {
    this.options.onError?.(error);
    this.cleanup();
  }

  private fail(error: RecorderError): void {
    if (this.failure) return;
    this.failure = error;
    this.options.onError?.(error);
    void this.stop();
  }

  private async complete(): Promise<void> {
    if (this.state === 'idle') return;
    if (this.state !== 'stopping') this.transition('stopping');
    await this.writeChain;
    const reported = this.failure;
    try {
      await this.writable?.close();
    } catch (error) {
      this.failure ??= { code: 'writeFailed', cause: error };
      if (!reported) this.options.onError?.(this.failure);
    }
    // サイズ上限は「そこまでの録画を残して止める」失敗。保存できていないのは書き込み系だけ。
    const recording = this.failure && this.failure.code !== 'sizeLimit' ? null : {
      filename: this.filename,
      extension: this.extension,
      mimeType: this.mimeType,
      startedAt: this.startedAt,
      durationSeconds: Math.max(1, Math.round((this.now() - this.startedAt) / 1000)),
      sizeBytes: this.sizeBytes,
      blob: this.fileHandle ? null : new Blob(this.chunks, { type: this.mimeType }),
      fileHandle: this.fileHandle,
    } satisfies LocalRecording;
    this.resolveCompletion?.(recording);
    this.cleanup();
  }

  private transition(next: RecorderState): void {
    this.state = next;
    this.options.onStateChange?.(next);
  }

  private emitElapsed(): void {
    this.options.onElapsed?.(Math.max(0, (this.now() - this.startedAt) / 1000));
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private cleanup(): void {
    if (this.elapsedTimer !== null) globalThis.clearInterval(this.elapsedTimer);
    this.elapsedTimer = null;
    this.recorder = null;
    this.writable = null;
    this.fileHandle = null;
    this.resolveCompletion = null;
    this.transition('idle');
  }
}

function filePickerOptions(filename: string, mimeType: string): Parameters<RecordingPicker>[0] {
  return { suggestedName: filename, types: [{ description: 'Video', accept: { [mimeType]: [`.${extensionForMimeType(mimeType)}`] } }] };
}

function extensionForMimeType(mimeType: string): string {
  return mimeType === 'video/mp4' ? 'mp4' : 'webm';
}

/** 中断時の後始末。閉じられなくても配信は続くので、記録だけ残す。 */
async function closeQuietly(writable: RecordingWritable | null): Promise<void> {
  if (!writable) return;
  try {
    await writable.close();
  } catch (error) {
    // ファイル名・ハンドル等が混ざらないよう、例外は種別だけをログに出す。
    console.warn('Failed to close the aborted recording file', error instanceof Error ? error.name : 'unknown');
  }
}
