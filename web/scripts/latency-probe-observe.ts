import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { formatLatencyCsv, latencyFromSecondBoundary, type LatencySample } from './latency-probe-analysis';
import { decodeBlockCodeFrameWithReason, decodeMonoWav, detectBeepOnsets, encodeMonoWav } from './latency-probe-codec';

/** 出口音声の再解析に必要なPCMと観測基準時刻。 */
export interface AudioCapture { samples: Float32Array; firstObservedAtMs: number | null; sampleRate: number }
interface AudioCaptureMetadata { firstObservedAtMs: number | null; sampleRate: number; sampleCount: number }
/** 出口映像の復号失敗を事後確認するための状態。 */
export interface VideoDiagnostics {
  firstDecoded: Uint8Array | null; lastDecoded: Uint8Array | null; lastFailure: Uint8Array | null;
  decodeLog: string[]; lastLoggedFailureAtMs: number | null;
}

/** 同じ復号失敗を診断ログへ再記録してよい時刻かを判定する。 */
export function shouldLogDecodeFailure(nowMs: number, lastLoggedAtMs: number | null, intervalMs = 5_000): boolean {
  return lastLoggedAtMs === null || nowMs - lastLoggedAtMs >= intervalMs;
}

/** ffprobeで先頭映像ストリームの寸法を取得する。 */
export async function probeDimensionsFor(input: string): Promise<{ width: number; height: number }> {
  const process = Bun.spawn(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', input], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, exitCode] = await Promise.all([readPipeText(requirePipe(process.stdout, 'ffprobe stdout')), process.exited]);
  if (exitCode !== 0) throw new Error('ffprobe could not read the RTSPT outlet');
  const [width, height] = stdout.trim().split(',').map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error('ffprobe returned invalid video dimensions');
  return { width, height };
}

/** RTSPT出口の映像プローブを起動する。 */
export function startVideoProbe(rtspUrl: string): Bun.Subprocess {
  return Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay', '-use_wallclock_as_timestamps', '1', '-i', rtspUrl, '-an', '-vf', 'fps=5', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { stdout: 'pipe', stderr: 'pipe' });
}

/** RTSPT出口のモノラル48kHz音声プローブを起動する。 */
export function startAudioProbe(rtspUrl: string): Bun.Subprocess {
  return Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay', '-use_wallclock_as_timestamps', '1', '-i', rtspUrl, '-vn', '-map', '0:a:0?', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { stdout: 'pipe', stderr: 'pipe' });
}

/** 指定時刻まで映像を読み、復号標本と失敗診断を蓄積する。 */
export async function collectVideo(stream: ReadableStream<Uint8Array>, width: number, height: number, until: number, output: LatencySample[], diagnostics: VideoDiagnostics, process: Bun.Subprocess): Promise<void> {
  const frameBytes = width * height * 3;
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const reader = stream.getReader();
  let nextRead = reader.read();
  while (Date.now() < until) {
    const chunk = await readWithTimeout(nextRead, Math.min(5_000, until - Date.now()));
    if (chunk === null) { logDecodeFailure(diagnostics, 'フレーム未到達', process.exitCode === null); continue; }
    nextRead = reader.read();
    if (chunk.done) { logDecodeFailure(diagnostics, 'フレーム未到達', false); await sleepUntil(until); break; }
    pending = appendBytes(pending, chunk.value);
    while (pending.length >= frameBytes && Date.now() < until) {
      const frame = pending.slice(0, frameBytes); pending = pending.slice(frameBytes);
      const decoded = decodeBlockCodeFrameWithReason(frame, width, height);
      if (decoded.timestampMs !== null) {
        const observedAtMs = Date.now();
        output.push({ observedAtMs, videoLatencyMs: observedAtMs - decoded.timestampMs, audioLatencyMs: null });
        diagnostics.firstDecoded ??= frame; diagnostics.lastDecoded = frame;
      } else {
        diagnostics.lastFailure = frame;
        logDecodeFailure(diagnostics, decoded.reason === 'checksum-mismatch' ? 'チェックサム不一致' : '同期パターン未検出', process.exitCode === null);
      }
    }
  }
}

/** 指定時刻まで音声を読み、WAV保存用のPCMを蓄積する。 */
export async function collectAudio(stream: ReadableStream<Uint8Array>, until: number): Promise<AudioCapture> {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let firstObservedAtMs: number | null = null;
  let sampleCount = 0;
  const chunks: Float32Array[] = [];
  const reader = stream.getReader();
  let nextRead = reader.read();
  while (Date.now() < until) {
    const chunk = await readWithTimeout(nextRead, Math.min(5_000, until - Date.now()));
    if (chunk === null) continue;
    nextRead = reader.read();
    if (chunk.done) { await sleepUntil(until); break; }
    pending = appendBytes(pending, chunk.value);
    const usable = pending.length - pending.length % 4;
    if (!usable) continue;
    const pcm = new Float32Array(pending.buffer.slice(pending.byteOffset, pending.byteOffset + usable));
    pending = pending.slice(usable);
    firstObservedAtMs ??= Date.now() - (sampleCount + pcm.length) / 48;
    sampleCount += pcm.length;
    chunks.push(pcm);
  }
  return { samples: joinFloat32Chunks(chunks), firstObservedAtMs, sampleRate: 48_000 };
}

/** 音声WAV・復号ログ・診断フレームを計測ディレクトリへ保存する。 */
export async function persistOutletArtifacts(outDir: string, startedAtMs: number, audio: AudioCapture, dimensions: { width: number; height: number }, diagnostics: VideoDiagnostics, videoLog: string, audioLog: string): Promise<void> {
  await writeFile(join(outDir, 'outlet-audio.wav'), encodeMonoWav(audio.samples, audio.sampleRate));
  await writeFile(join(outDir, 'outlet-audio.json'), JSON.stringify({ firstObservedAtMs: audio.firstObservedAtMs, sampleRate: audio.sampleRate, sampleCount: audio.samples.length } satisfies AudioCaptureMetadata, null, 2) + '\n');
  await writeFile(join(outDir, 'outlet-audio.csv'), formatLatencyCsv(audioSamplesFromCapture(audio), startedAtMs));
  await writeFile(join(outDir, 'outlet-ffmpeg.log'), `[video]\n${videoLog}\n[audio]\n${audioLog}`);
  await writeFile(join(outDir, 'outlet-decode.log'), diagnostics.decodeLog.join('\n') + (diagnostics.decodeLog.length ? '\n' : ''));
  const frames = join(outDir, 'frames');
  await mkdir(frames, { recursive: true });
  if (diagnostics.firstDecoded) await saveRgbFramePng(diagnostics.firstDecoded, dimensions, join(frames, 'first-decoded.png'));
  if (diagnostics.lastDecoded) await saveRgbFramePng(diagnostics.lastDecoded, dimensions, join(frames, 'last-decoded.png'));
  if (diagnostics.lastFailure) await saveRgbFramePng(diagnostics.lastFailure, dimensions, join(frames, 'last-failure.png'));
}

/** 保存済み出口WAVを再解析し、音声標本を返す。 */
export async function analyzeSavedOutletAudio(directory: string): Promise<LatencySample[] | null> {
  const wavPath = join(directory, 'outlet-audio.wav');
  const metadataPath = join(directory, 'outlet-audio.json');
  if (!await Bun.file(wavPath).exists() || !await Bun.file(metadataPath).exists()) return null;
  const wav = decodeMonoWav(new Uint8Array(await readFile(wavPath)));
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Partial<AudioCaptureMetadata>;
  if (typeof metadata.firstObservedAtMs !== 'number' || !Number.isFinite(metadata.firstObservedAtMs) || metadata.sampleRate !== wav.sampleRate) throw new Error('outlet-audio.json has invalid capture metadata');
  return audioSamplesFromCapture({ samples: wav.samples, sampleRate: wav.sampleRate, firstObservedAtMs: metadata.firstObservedAtMs });
}

/** 捕捉PCMのビープをUTC秒境界との差へ変換する。 */
export function audioSamplesFromCapture(capture: AudioCapture): LatencySample[] {
  if (capture.firstObservedAtMs === null) return [];
  const firstObservedAtMs = capture.firstObservedAtMs;
  return detectBeepOnsets(capture.samples, capture.sampleRate).map((onset) => {
    const observedAtMs = firstObservedAtMs + onset * (1_000 / capture.sampleRate);
    return { observedAtMs, videoLatencyMs: null, audioLatencyMs: latencyFromSecondBoundary(observedAtMs) };
  });
}

/** Pipeではないsubprocess出力を明示的に拒否する。 */
export function requirePipe(pipe: number | ReadableStream<Uint8Array> | undefined, name: string): ReadableStream<Uint8Array> {
  if (!pipe || typeof pipe === 'number') throw new Error(`${name} probe pipe is unavailable`);
  return pipe;
}

/** subprocessのテキスト出力を最後まで読む。 */
export async function readPipeText(stream: ReadableStream<Uint8Array>): Promise<string> { return new Response(stream).text(); }

function logDecodeFailure(diagnostics: VideoDiagnostics, reason: string, ffmpegAlive: boolean): void {
  const nowMs = Date.now();
  if (!shouldLogDecodeFailure(nowMs, diagnostics.lastLoggedFailureAtMs)) return;
  diagnostics.lastLoggedFailureAtMs = nowMs;
  diagnostics.decodeLog.push(`${new Date(nowMs).toISOString()} reason=${reason} ffmpeg_alive=${ffmpegAlive}`);
}

async function saveRgbFramePng(frame: Uint8Array, dimensions: { width: number; height: number }, path: string): Promise<void> {
  const child = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${dimensions.width}x${dimensions.height}`, '-i', 'pipe:0', '-frames:v', '1', '-y', path], { stdin: 'pipe', stdout: 'ignore', stderr: 'pipe' });
  child.stdin.write(frame); child.stdin.end();
  const stderr = await readPipeText(requirePipe(child.stderr, 'frame PNG stderr'));
  if (await child.exited !== 0) throw new Error(`フレームPNG保存に失敗しました: ${stderr}`);
}

async function readWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) return null;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => resolve(null), timeoutMs);
    promise.then((value) => { clearTimeout(timeout); resolve(value); }, (error: unknown) => { clearTimeout(timeout); reject(error); });
  });
}

async function sleepUntil(until: number): Promise<void> { const remaining = until - Date.now(); if (remaining > 0) await Bun.sleep(remaining); }
function appendBytes(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> { const merged = new Uint8Array(left.length + right.length); merged.set(left); merged.set(right, left.length); return merged; }
function joinFloat32Chunks(chunks: readonly Float32Array[]): Float32Array { const result = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0)); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result; }
