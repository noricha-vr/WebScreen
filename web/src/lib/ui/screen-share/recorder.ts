/** ブラウザ内のローカル録画を開始・停止し、配信の MediaStream を借用する。 */
export const MAX_RECORDING_BYTES = 1024 * 1024 * 1024;
const CHUNK_INTERVAL_MS = 1000;

export type RecorderState = 'idle' | 'recording' | 'stopping';
export type RecorderErrorCode = 'unsupported' | 'writeFailed' | 'sizeLimit' | 'totalLimit';

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
  /** 録画の実体。ダウンロードするまでタブのメモリに載る。 */
  blob: Blob;
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

export interface ScreenRecorderOptions {
  MediaRecorder: MediaRecorderConstructor | null;
  now?: () => number;
  onError?: (error: RecorderError) => void;
  onElapsed?: (seconds: number) => void;
  onStateChange?: (state: RecorderState) => void;
  /** 完成した録画の唯一の受け渡し口。外部 stop・サイズ上限・エラー停止のどの経路でもここだけを通る。 */
  onRecordingComplete?: (recording: LocalRecording) => void;
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
  private recorder: RecorderInstance | null = null;
  private chunks: Blob[] = [];
  private sizeBytes = 0;
  private startedAt = 0;
  private filename = '';
  private mimeType = '';
  private extension = '';
  private completion: Promise<void> | null = null;
  private resolveCompletion: (() => void) | null = null;
  private failure: RecorderError | null = null;
  private elapsedTimer: ReturnType<typeof globalThis.setInterval> | null = null;

  constructor(private readonly options: ScreenRecorderOptions) {}

  get currentState(): RecorderState {
    return this.state;
  }

  /** 停止すべき録画を抱えているか。 */
  get isActive(): boolean {
    return this.state !== 'idle';
  }

  /**
   * 選んだ共有 stream を借用して、1 秒単位のチャンク録画を開始する。
   * 開始は同期で完了させる。途中に await を挟むと、その待機中に届いた stop() を取りこぼして
   * 「誰も止められない録画」ができるため、非同期の準備処理をここへ足さない。
   */
  start(stream: MediaStream, filenameBase: string): void {
    if (this.isActive) return;
    const candidate = this.selectMimeType();
    if (!candidate || !this.options.MediaRecorder) return this.failStart({ code: 'unsupported' });

    this.reset(`${filenameBase}.${candidate.extension}`, candidate.mimeType, candidate.extension);
    try {
      const recorder = new this.options.MediaRecorder(stream, { mimeType: candidate.mimeType });
      this.recorder = recorder;
      recorder.ondataavailable = (event) => this.receiveChunk(event.data);
      recorder.onerror = (event) => this.fail({ code: 'writeFailed', cause: event });
      recorder.onstop = () => this.complete();
      this.transition('recording');
      recorder.start(CHUNK_INTERVAL_MS);
      this.elapsedTimer = globalThis.setInterval(() => this.emitElapsed(), CHUNK_INTERVAL_MS);
      this.emitElapsed();
    } catch (error) {
      // fail() が停止と完了まで進めるので、ここでは何も待たない（complete の二重実行を避ける）。
      this.fail({ code: 'writeFailed', cause: error });
    }
  }

  /** 録画を止め、完了までを待つ。録画自体は onRecordingComplete で渡す。 */
  stop(): Promise<void> {
    if (this.state === 'idle') return Promise.resolve();
    if (this.state === 'stopping') return this.completion ?? Promise.resolve();
    this.transition('stopping');
    // MediaRecorder を作れなかった経路でも完了させる（待ち手を宙づりにしない）。
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    else this.complete();
    return this.completion ?? Promise.resolve();
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
    this.completion = new Promise((resolve) => { this.resolveCompletion = resolve; });
  }

  private receiveChunk(chunk: Blob): void {
    if (this.state === 'idle' || chunk.size === 0 || this.failure) return;
    // Blob はタブのメモリに積み上がるので、上限に達したらそこまでを残して自動停止する。
    if (this.sizeBytes + chunk.size > (this.options.maxBytes ?? MAX_RECORDING_BYTES)) {
      this.fail({ code: 'sizeLimit' });
      return;
    }
    this.sizeBytes += chunk.size;
    this.chunks.push(chunk);
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

  /** 停止の後始末。cleanup で state が idle になるので、二度目以降はここで止まる。 */
  private complete(): void {
    if (this.state === 'idle') return;
    if (this.state !== 'stopping') this.transition('stopping');
    // サイズ上限は「そこまでの録画を残して止める」失敗。他の失敗は保存物として残さない。
    const recording = this.failure && this.failure.code !== 'sizeLimit' ? null : {
      filename: this.filename,
      extension: this.extension,
      mimeType: this.mimeType,
      startedAt: this.startedAt,
      durationSeconds: Math.max(1, Math.round((this.now() - this.startedAt) / 1000)),
      sizeBytes: this.sizeBytes,
      blob: new Blob(this.chunks, { type: this.mimeType }),
    } satisfies LocalRecording;
    const finished = this.resolveCompletion;
    this.cleanup();
    try {
      // 一覧へ積んでから待ち合わせを解く（停止を待つ側が、積み終わった状態を見られるようにする）。
      if (recording) this.options.onRecordingComplete?.(recording);
    } finally {
      // 通知が失敗しても停止の待ち合わせは必ず解く（配信停止を録画側で止めない）。
      finished?.();
    }
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
    // 合成済みの Blob を complete() が持っているので、元のチャンクはここで手放す
    // （抱えたままだとダウンロード後に Blob を解放してもメモリが戻らない）。
    this.chunks = [];
    this.recorder = null;
    this.resolveCompletion = null;
    this.transition('idle');
  }
}
