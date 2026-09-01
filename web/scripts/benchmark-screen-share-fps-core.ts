/** 画面共有の自動選択方式。 */
export type CaptureMode = 'tab' | 'screen';

/** 検証済みのCLI設定。 */
export interface BenchmarkOptions {
  mode: CaptureMode;
  durationSeconds: number;
  fps: number[];
  source: string | null;
  help: boolean;
}

/** ブラウザから持ち出してよい最小限のWebRTC stats。 */
export interface StatsRow {
  id: string;
  type: string;
  kind?: string;
  mediaType?: string;
  codecId?: string;
  mimeType?: string;
  framesEncoded?: number;
  keyFramesEncoded?: number;
  bytesSent?: number;
  qpSum?: number;
  totalEncodeTime?: number;
  framesSent?: number;
  frameWidth?: number;
  frameHeight?: number;
  qualityLimitationReason?: string;
}

/** 差分計算前のprimary H.264 stats。 */
export interface VideoStatsSnapshot {
  outboundId: string;
  codecId: string;
  codecMimeType: string;
  counters: Record<CounterName, number>;
  frameWidth: number | null;
  frameHeight: number | null;
  qualityLimitationReason: string | null;
}

/** 計測区間だけに限定したH.264 stats。 */
export interface VideoStatsInterval {
  codecMimeType: string;
  framesEncoded: number;
  keyFramesEncoded: number;
  bytesSent: number;
  qpSum: number;
  totalEncodeTime: number;
  framesSent: number;
  encodedFramesPerSecond: number;
  frameWidth: number | null;
  frameHeight: number | null;
  qualityLimitationReason: string | null;
}

type CounterName =
  | 'framesEncoded'
  | 'keyFramesEncoded'
  | 'bytesSent'
  | 'qpSum'
  | 'totalEncodeTime'
  | 'framesSent';

const DEFAULT_FPS = [24, 30];
const COUNTERS: CounterName[] = [
  'framesEncoded',
  'keyFramesEncoded',
  'bytesSent',
  'qpSum',
  'totalEncodeTime',
  'framesSent',
];
const AUXILIARY_VIDEO_CODECS = /^video\/(rtx|red|ulpfec|flexfec)/i;

/** CLI引数を検証し、指定されたfps順序を保つ設定へ変換する。 */
export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env
): BenchmarkOptions {
  const options: BenchmarkOptions = {
    mode: 'tab',
    durationSeconds: 10,
    fps: [...DEFAULT_FPS],
    source: env.SCREEN_CAPTURE_SOURCE?.trim() || null,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    const separator = token.indexOf('=');
    const name = separator < 0 ? token : token.slice(0, separator);
    const inlineValue = separator < 0 ? undefined : token.slice(separator + 1);
    if (name === '--help' || name === '-h') {
      options.help = true;
      continue;
    }
    if (!['--mode', '--duration', '--fps', '--source'].includes(name)) {
      throw new Error(`Unknown option: ${name}`);
    }
    const value = inlineValue ?? argv[++index];
    if (!value) throw new Error(`${name} requires a value`);
    if (name === '--mode') options.mode = parseMode(value);
    if (name === '--duration') options.durationSeconds = parseNumber(value, name, 1, 900);
    if (name === '--fps') options.fps = parseFpsList(value);
    if (name === '--source') options.source = value;
  }
  if (!options.help && options.mode === 'tab' && options.source) {
    throw new Error('--source and SCREEN_CAPTURE_SOURCE are only valid with --mode screen');
  }
  return options;
}

function parseMode(value: string): CaptureMode {
  if (value === 'tab' || value === 'screen') return value;
  throw new Error('--mode must be tab or screen');
}

function parseNumber(value: string, name: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseFpsList(value: string): number[] {
  const fps = value.split(',').map((item) => parseNumber(item, '--fps', 1, 120));
  if (fps.length === 0) throw new Error('--fps requires at least one value');
  return fps;
}

/** codec参照から唯一のprimary H.264 video outbound reportを選ぶ。 */
export function selectPrimaryH264VideoOutbound(
  rows: readonly StatsRow[]
): { outbound: StatsRow; codec: StatsRow } {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const resolved = rows
    .filter((row) => row.type === 'outbound-rtp' && (row.kind === 'video' || row.mediaType === 'video'))
    .map((outbound) => {
      const codec = outbound.codecId ? byId.get(outbound.codecId) : undefined;
      if (!codec?.mimeType) throw new Error(`video outbound ${outbound.id} has no known codec`);
      return { outbound, codec };
    })
    .filter(({ codec }) => !AUXILIARY_VIDEO_CODECS.test(codec.mimeType!));
  if (resolved.length !== 1) throw new Error(`expected one primary video outbound, got ${resolved.length}`);
  const primary = resolved[0]!;
  if (!/^video\/h264$/i.test(primary.codec.mimeType!)) {
    throw new Error(`primary video codec is not H.264: ${primary.codec.mimeType}`);
  }
  return primary;
}

/** H.264 outbound reportを差分計算可能なsnapshotへ変換する。 */
export function snapshotPrimaryVideoStats(rows: readonly StatsRow[]): VideoStatsSnapshot {
  const { outbound, codec } = selectPrimaryH264VideoOutbound(rows);
  const counters = Object.fromEntries(
    COUNTERS.map((name) => [name, requiredCounter(outbound, name)])
  ) as Record<CounterName, number>;
  return {
    outboundId: outbound.id,
    codecId: codec.id,
    codecMimeType: codec.mimeType!,
    counters,
    frameWidth: optionalDimension(outbound.frameWidth),
    frameHeight: optionalDimension(outbound.frameHeight),
    qualityLimitationReason: outbound.qualityLimitationReason ?? null,
  };
}

/** 開始・終了snapshotの差分から計測区間だけのH.264送出統計を返す。 */
export function diffVideoStats(
  start: VideoStatsSnapshot,
  end: VideoStatsSnapshot,
  elapsedMs: number
): VideoStatsInterval {
  if (!(elapsedMs > 0) || !Number.isFinite(elapsedMs)) throw new Error('elapsedMs must be positive');
  if (start.outboundId !== end.outboundId || start.codecId !== end.codecId) {
    throw new Error('primary H.264 stats identity changed during measurement');
  }
  const delta = Object.fromEntries(COUNTERS.map((name) => {
    const value = end.counters[name] - start.counters[name];
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} counter reset during measurement`);
    return [name, value];
  })) as Record<CounterName, number>;
  return {
    codecMimeType: end.codecMimeType,
    ...delta,
    encodedFramesPerSecond: delta.framesEncoded / (elapsedMs / 1_000),
    frameWidth: end.frameWidth,
    frameHeight: end.frameHeight,
    qualityLimitationReason: end.qualityLimitationReason,
  };
}

function requiredCounter(row: StatsRow, name: CounterName): number {
  const value = row[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function optionalDimension(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** 終了時に一度だけ呼ぶcleanup処理。 */
export type CleanupTask = () => void | Promise<void>;

/** cleanup taskを逆順かつ冪等に実行するstackを作る。 */
export function createCleanupStack(): { add(task: CleanupTask): void; run(): Promise<void> } {
  const tasks: CleanupTask[] = [];
  let cleanupPromise: Promise<void> | undefined;
  return {
    add(task): void {
      if (cleanupPromise) throw new Error('cleanup already started');
      tasks.push(task);
    },
    run(): Promise<void> {
      cleanupPromise ??= (async () => {
        const errors: unknown[] = [];
        for (const task of tasks.reverse()) {
          try { await task(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, 'cleanup failed');
      })();
      return cleanupPromise;
    },
  };
}

/** CLIが処理する終了signal。 */
export type BenchmarkSignal = 'SIGINT' | 'SIGTERM';

/** signal時にcleanupを一度だけ待ち、標準のsignal exit codeで終了するhandlerを作る。 */
export function createSignalHandler(
  cleanup: () => Promise<void>,
  exit: (code: number) => void,
  reportError: (error: unknown) => void = () => undefined
): (signal: BenchmarkSignal) => Promise<void> {
  let handled = false;
  return async (signal) => {
    if (handled) return;
    handled = true;
    try {
      await cleanup();
      exit(signal === 'SIGINT' ? 130 : 143);
    } catch (error) {
      reportError(error);
      exit(1);
    }
  };
}
