import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { selectPrimaryH264VideoOutbound, type StatsRow } from './benchmark-screen-share-fps-core';

/** 送出側primary H.264 reportをそのまま保存する1秒標本。 */
export interface SenderSample {
  observedAtMs: number;
  framesPerSecond: number | null;
  framesEncoded: number;
  keyFramesEncoded: number;
  frameWidth: number | null;
  frameHeight: number | null;
  bytesSent: number;
  qpSum: number;
  totalEncodeTime: number;
  qualityLimitationReason: string | null;
  qualityLimitationDurations: Record<'none' | 'cpu' | 'bandwidth' | 'other', number | null>;
}

interface SenderStatsRow extends StatsRow {
  framesPerSecond?: number;
  qualityLimitationDurations?: Record<string, unknown>;
}

interface PagePeerConnectionWindow extends Window {
  __webscreenHarnessPeerConnections?: RTCPeerConnection[];
}

/** RTCPeerConnection生成を記録するinit scriptを返す。 */
export function peerConnectionTrackerInitScript(): () => void {
  return () => {
    const tracked = window as PagePeerConnectionWindow;
    const Original = globalThis.RTCPeerConnection;
    if (!Original || tracked.__webscreenHarnessPeerConnections) return;
    const instances: RTCPeerConnection[] = [];
    // Proxyはnative constructorのstatic propertyを保つため、ページ側のfeature detectionを変えない。
    globalThis.RTCPeerConnection = new Proxy(Original, { construct(target, args) {
      const connection = Reflect.construct(target, args) as RTCPeerConnection;
      instances.push(connection);
      return connection;
    } });
    tracked.__webscreenHarnessPeerConnections = instances;
  };
}

/** 実際に選ばれたsender/track設定、または取得失敗理由をJSON用に返す。 */
export async function captureSenderConfig(page: import('@playwright/test').Page): Promise<Record<string, unknown>> {
  try {
    return await page.evaluate(async () => {
      const connections = (window as PagePeerConnectionWindow).__webscreenHarnessPeerConnections ?? [];
      const sender = connections.flatMap((connection) => connection.getSenders()).find((candidate) => candidate.track?.kind === 'video');
      if (!sender?.track) return { error: 'video RTCRtpSender was not found after screen share started' };
      const parameters = sender.getParameters();
      const settings = sender.track.getSettings();
      return {
        capturedAtUtc: new Date().toISOString(),
        sender: {
          degradationPreference: parameters.degradationPreference ?? null,
          maxBitrate: parameters.encodings?.[0]?.maxBitrate ?? null,
          scaleResolutionDownBy: parameters.encodings?.[0]?.scaleResolutionDownBy ?? null,
        },
        track: {
          contentHint: sender.track.contentHint || null,
          width: settings.width ?? null,
          height: settings.height ?? null,
          frameRate: settings.frameRate ?? null,
        },
      };
    });
  } catch (error) {
    return { error: `sender configuration capture failed: ${errorMessage(error)}` };
  }
}

/** 指定終了時刻まで1秒間隔でprimary video outbound-rtpをCSVへ保存する。 */
export async function collectSenderStats(
  page: import('@playwright/test').Page, outDir: string, until: number, signal?: AbortSignal
): Promise<{ samples: SenderSample[]; error: string | null }> {
  const samples: SenderSample[] = [];
  let error: string | null = null;
  try {
    while (Date.now() < until && !signal?.aborted) {
      try {
        samples.push(await readSenderSample(page));
      } catch (caught) {
        error ??= `sender stats collection failed: ${errorMessage(caught)}`;
      }
      const remaining = until - Date.now();
      if (remaining > 0 && !signal?.aborted) await Bun.sleep(Math.min(1_000, remaining));
    }
  } finally {
    await writeFile(join(outDir, 'sender.csv'), formatSenderCsv(samples));
    if (error) await writeFile(join(outDir, 'sender-error.md'), `${error}\n`);
  }
  return { samples, error };
}

/** sender.csvを再集計用に読み込む。 */
export function parseSenderCsv(csv: string): SenderSample[] {
  const rows = csv.trim().split(/\r?\n/);
  if (!rows.length || rows[0] !== SENDER_CSV_HEADER) throw new Error('unexpected sender CSV header');
  return rows.slice(1).filter(Boolean).map((row, index) => {
    const values = row.split(',');
    const observedAtMs = Date.parse(values[0] ?? '');
    if (!Number.isFinite(observedAtMs)) throw new Error(`invalid sender timestamp at row ${index + 2}`);
    return {
      observedAtMs,
      framesPerSecond: parseOptionalNumber(values[2]),
      framesEncoded: parseRequiredNumber(values[3], 'framesEncoded', index),
      keyFramesEncoded: parseRequiredNumber(values[4], 'keyFramesEncoded', index),
      frameWidth: parseOptionalNumber(values[5]), frameHeight: parseOptionalNumber(values[6]),
      bytesSent: parseRequiredNumber(values[7], 'bytesSent', index), qpSum: parseRequiredNumber(values[8], 'qpSum', index),
      totalEncodeTime: parseRequiredNumber(values[9], 'totalEncodeTime', index), qualityLimitationReason: values[10] || null,
      qualityLimitationDurations: {
        none: parseOptionalNumber(values[11]), cpu: parseOptionalNumber(values[12]),
        bandwidth: parseOptionalNumber(values[13]), other: parseOptionalNumber(values[14]),
      },
    };
  });
}

/** raw sender countersの差分からA/B比較用の送出側Markdown節を作る。 */
export function formatSenderSummary(samples: readonly SenderSample[]): string {
  if (samples.length < 2) return '## 送出側\n\n- sender.csv の有効標本が2件未満のため、差分集計はできません。\n';
  const first = samples[0]!, last = samples.at(-1)!;
  const elapsedSeconds = (last.observedAtMs - first.observedAtMs) / 1_000;
  const delta = (name: keyof Pick<SenderSample, 'framesEncoded' | 'keyFramesEncoded' | 'bytesSent' | 'qpSum' | 'totalEncodeTime'>): number => last[name] - first[name];
  const frames = delta('framesEncoded');
  const value = (number: number | null, digits = 2): string => number === null || !Number.isFinite(number) ? 'n/a' : number.toFixed(digits);
  return [
    '## 送出側', '',
    `- 集計窓: ${elapsedSeconds.toFixed(2)} 秒（${samples.length} 標本）`,
    `- 区間 fps: ${value(frames / elapsedSeconds)}`,
    `- 区間平均ビットレート: ${value(delta('bytesSent') * 8 / elapsedSeconds, 0)} bps`,
    `- 区間平均 QP: ${value(frames > 0 ? delta('qpSum') / frames : null)}`,
    `- フレームあたりエンコード時間: ${value(frames > 0 ? delta('totalEncodeTime') * 1_000 / frames : null)} ms`,
    `- keyframe: ${value(delta('keyFramesEncoded'), 0)} / encoded frame: ${value(frames, 0)}`,
    '',
  ].join('\n');
}

/** 連続ffmpegを画質専用に使い、遅延用の単発取得と分離して出口品質を保存する。 */
export async function collectOutletQuality(
  rtspUrl: string, outDir: string, startedAtMs: number, until: number, windowSeconds: number, signal?: AbortSignal
): Promise<{ error: string | null }> {
  const samples: OutletQualitySample[] = [];
  const logs: string[] = [];
  let error: string | null = null;
  let previousDimensions: string | null = null;
  try {
    for (let index = 0; Date.now() < until && !signal?.aborted; index += 1) {
      const remainingSeconds = (until - Date.now()) / 1_000;
      if (remainingSeconds < 1) break;
      const seconds = Math.min(windowSeconds, remainingSeconds);
      const started = Date.now();
      try {
        const result = await measureOutletQualityWindow(rtspUrl, seconds);
        const dimensions = `${result.width ?? '?'}x${result.height ?? '?'}`;
        samples.push({ index, startedAtMs: started, durationSeconds: result.durationSeconds, frames: result.frames, receivedBytes: result.receivedBytes, width: result.width, height: result.height, resolutionEvents: result.resolutionEvents, freezes: result.freezes, freezeSeconds: result.freezeSeconds, resolutionChanged: result.resolutionEvents.length > 1 || (previousDimensions !== null && previousDimensions !== dimensions), status: 'ok' });
        previousDimensions = dimensions;
        logs.push(`## window ${index + 1}\n\n${result.log}`);
      } catch (caught) {
        error ??= `outlet quality collection failed: ${errorMessage(caught)}`;
        samples.push({ index, startedAtMs: started, durationSeconds: 0, frames: null, receivedBytes: null, width: null, height: null, resolutionEvents: [], freezes: null, freezeSeconds: null, resolutionChanged: false, status: 'error' });
        logs.push(`## window ${index + 1} error\n\n${errorMessage(caught)}`);
        break;
      }
    }
  } finally {
    await writeFile(join(outDir, 'outlet-quality.csv'), formatOutletQualityCsv(samples, startedAtMs));
    await writeFile(join(outDir, 'outlet-quality.md'), formatOutletQualitySummary(samples, windowSeconds));
    await writeFile(join(outDir, 'outlet-quality.log'), `${logs.join('\n\n')}\n`);
  }
  return { error };
}

interface OutletQualitySample {
  index: number; startedAtMs: number; durationSeconds: number; frames: number | null; receivedBytes: number | null;
  width: number | null; height: number | null; resolutionEvents: string[]; freezes: number | null; freezeSeconds: number | null;
  resolutionChanged: boolean; status: 'ok' | 'error';
}

const SENDER_CSV_HEADER = 'timestamp_utc,elapsed_s,frames_per_second,frames_encoded,key_frames_encoded,frame_width,frame_height,bytes_sent,qp_sum,total_encode_time,quality_limitation_reason,quality_limitation_none_s,quality_limitation_cpu_s,quality_limitation_bandwidth_s,quality_limitation_other_s';

async function readSenderSample(page: import('@playwright/test').Page): Promise<SenderSample> {
  const result = await page.evaluate(async () => {
    // page.evaluate はシリアライズした関数だけをページへ送るため、module scope の helper は参照できない。同名で閉包内に定義する
    const stringValue = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
    const numberValue = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
    const recordValue = (value: unknown): Record<string, unknown> | undefined => (value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined);
    const connections = (window as PagePeerConnectionWindow).__webscreenHarnessPeerConnections ?? [];
    const rows: SenderStatsRow[] = [];
    for (const connection of connections) {
      const stats = await connection.getStats();
      stats.forEach((report) => {
        const item = report as unknown as Record<string, unknown>;
        rows.push({ id: String(report.id), type: String(report.type), kind: stringValue(item.kind), mediaType: stringValue(item.mediaType), codecId: stringValue(item.codecId), mimeType: stringValue(item.mimeType), framesPerSecond: numberValue(item.framesPerSecond), framesEncoded: numberValue(item.framesEncoded), keyFramesEncoded: numberValue(item.keyFramesEncoded), frameWidth: numberValue(item.frameWidth), frameHeight: numberValue(item.frameHeight), bytesSent: numberValue(item.bytesSent), qpSum: numberValue(item.qpSum), totalEncodeTime: numberValue(item.totalEncodeTime), qualityLimitationReason: stringValue(item.qualityLimitationReason), qualityLimitationDurations: recordValue(item.qualityLimitationDurations) });
      });
    }
    return { observedAtMs: Date.now(), rows };
  });
  const { outbound } = selectPrimaryH264VideoOutbound(result.rows);
  const row = outbound as SenderStatsRow;
  return {
    observedAtMs: result.observedAtMs, framesPerSecond: optionalNumber(row.framesPerSecond), framesEncoded: requiredNumber(row.framesEncoded, 'framesEncoded'), keyFramesEncoded: requiredNumber(row.keyFramesEncoded, 'keyFramesEncoded'), frameWidth: optionalNumber(row.frameWidth), frameHeight: optionalNumber(row.frameHeight), bytesSent: requiredNumber(row.bytesSent, 'bytesSent'), qpSum: requiredNumber(row.qpSum, 'qpSum'), totalEncodeTime: requiredNumber(row.totalEncodeTime, 'totalEncodeTime'), qualityLimitationReason: row.qualityLimitationReason ?? null,
    qualityLimitationDurations: qualityDurations(row.qualityLimitationDurations),
  };
}

async function measureOutletQualityWindow(rtspUrl: string, seconds: number): Promise<{ durationSeconds: number; frames: number | null; receivedBytes: number; width: number | null; height: number | null; resolutionEvents: string[]; freezes: number; freezeSeconds: number; log: string }> {
  // `-t` は直後の出力にしか効かない。2 本目（byte 計数用 mpegts）にも付けないと ffmpeg が終わらず run 全体が固まる
  const duration = seconds.toFixed(3);
  const child = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'info', '-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay', '-i', rtspUrl, '-t', duration, '-map', '0:v:0', '-an', '-vf', 'freezedetect=n=-60dB:d=0.4,showinfo', '-f', 'null', '-', '-t', duration, '-map', '0:v:0', '-c:v', 'copy', '-f', 'mpegts', 'pipe:1'], { stdout: 'pipe', stderr: 'pipe' });
  const stdout = child.stdout;
  if (!stdout || typeof stdout === 'number' || !child.stderr || typeof child.stderr === 'number') throw new Error('outlet quality ffmpeg pipes are unavailable');
  // 出口が止まって ffmpeg が入力待ちのまま終わらない場合の上限（窓長 + 接続猶予）
  const watchdog = setTimeout(() => child.kill(), (seconds + 20) * 1_000);
  const [receivedBytes, log, exit] = await Promise.all([countBytes(stdout), new Response(child.stderr).text(), child.exited]).finally(() => clearTimeout(watchdog));
  if (exit !== 0) throw new Error(`ffmpeg exit=${exit}: ${log.slice(-800)}`);
  const durationSeconds = Math.max(0.001, seconds);
  const frames = lastNumber(log, /frame=\s*(\d+)/g);
  const resolutionEvents = [...new Set(Array.from(log.matchAll(/\bs:(\d{2,5})x(\d{2,5})\b/g), (match) => `${match[1]}x${match[2]}`))];
  const dimensions = resolutionEvents.at(-1)?.split('x').map(Number) ?? null;
  const freezeDurations = Array.from(log.matchAll(/freeze_duration:\s*([0-9.]+)/g), (match) => Number(match[1])).filter(Number.isFinite);
  return { durationSeconds, frames, receivedBytes, width: dimensions?.[0] ?? null, height: dimensions?.[1] ?? null, resolutionEvents, freezes: freezeDurations.length, freezeSeconds: freezeDurations.reduce((total, duration) => total + duration, 0), log };
}

function formatSenderCsv(samples: readonly SenderSample[]): string {
  const startedAtMs = samples[0]?.observedAtMs ?? 0;
  return [SENDER_CSV_HEADER, ...samples.map((sample) => [new Date(sample.observedAtMs).toISOString(), ((sample.observedAtMs - startedAtMs) / 1_000).toFixed(3), optionalCsv(sample.framesPerSecond), sample.framesEncoded, sample.keyFramesEncoded, optionalCsv(sample.frameWidth), optionalCsv(sample.frameHeight), sample.bytesSent, sample.qpSum, sample.totalEncodeTime, sample.qualityLimitationReason ?? '', optionalCsv(sample.qualityLimitationDurations.none), optionalCsv(sample.qualityLimitationDurations.cpu), optionalCsv(sample.qualityLimitationDurations.bandwidth), optionalCsv(sample.qualityLimitationDurations.other)].join(','))].join('\n') + '\n';
}

function formatOutletQualityCsv(samples: readonly OutletQualitySample[], startedAtMs: number): string {
  const header = 'window,start_utc,elapsed_s,duration_s,frames,received_fps,received_bytes,effective_bitrate_bps,frame_width,frame_height,resolution_events,resolution_changed,freezes,freeze_seconds,status';
  return [header, ...samples.map((sample) => [sample.index + 1, new Date(sample.startedAtMs).toISOString(), ((sample.startedAtMs - startedAtMs) / 1_000).toFixed(3), sample.durationSeconds.toFixed(3), optionalCsv(sample.frames), optionalCsv(sample.frames === null || sample.durationSeconds <= 0 ? null : sample.frames / sample.durationSeconds), optionalCsv(sample.receivedBytes), optionalCsv(sample.receivedBytes === null || sample.durationSeconds <= 0 ? null : sample.receivedBytes * 8 / sample.durationSeconds), optionalCsv(sample.width), optionalCsv(sample.height), sample.resolutionEvents.join('|'), sample.resolutionChanged ? 'yes' : '', optionalCsv(sample.freezes), optionalCsv(sample.freezeSeconds), sample.status].join(','))].join('\n') + '\n';
}

function formatOutletQualitySummary(samples: readonly OutletQualitySample[], windowSeconds: number): string {
  const ok = samples.filter((sample) => sample.status === 'ok');
  const totalFreezeSeconds = ok.reduce((total, sample) => total + (sample.freezeSeconds ?? 0), 0);
  const changes = ok.filter((sample) => sample.resolutionChanged).map((sample) => sample.index + 1);
  return ['# 出口画質計測', '', `- 設定窓: ${windowSeconds} 秒、実行窓: ${samples.length} 回（各開始時刻は outlet-quality.csv）`, `- freeze: ${ok.reduce((total, sample) => total + (sample.freezes ?? 0), 0)} 回 / ${totalFreezeSeconds.toFixed(3)} 秒`, `- 解像度変化: ${changes.length ? `window ${changes.join(', ')}` : 'なし'}`, '- 受信fps・実解像度・実効ビットレートは各窓を outlet-quality.csv で比較する。', ''].join('\n');
}

function qualityDurations(value: Record<string, unknown> | undefined): SenderSample['qualityLimitationDurations'] { return { none: optionalNumber(value?.none), cpu: optionalNumber(value?.cpu), bandwidth: optionalNumber(value?.bandwidth), other: optionalNumber(value?.other) }; }
function recordValue(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function requiredNumber(value: number | undefined, name: string): number { if (value === undefined) throw new Error(`${name} is missing from primary video outbound-rtp`); return value; }
function optionalNumber(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function optionalCsv(value: number | null): string { return value === null ? '' : String(value); }
function parseOptionalNumber(value: string | undefined): number | null { if (!value) return null; const parsed = Number(value); if (!Number.isFinite(parsed)) throw new Error('invalid sender numeric value'); return parsed; }
function parseRequiredNumber(value: string | undefined, name: string, index: number): number { const parsed = parseOptionalNumber(value); if (parsed === null) throw new Error(`invalid ${name} at sender row ${index + 2}`); return parsed; }
function lastNumber(text: string, pattern: RegExp): number | null { const values = Array.from(text.matchAll(pattern), (match) => Number(match[1])).filter(Number.isFinite); return values.at(-1) ?? null; }
async function countBytes(stream: ReadableStream<Uint8Array>): Promise<number> { let bytes = 0; const reader = stream.getReader(); for (;;) { const item = await reader.read(); if (item.done) return bytes; bytes += item.value.length; } }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
