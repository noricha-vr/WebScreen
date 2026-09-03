/** 1標本分の遅延値。 */
export interface LatencySample {
  observedAtMs: number;
  videoLatencyMs: number | null;
  audioLatencyMs: number | null;
  audioLatencyPhaseMs?: number | null;
}

/** CSVから再生成可能な集計値。 */
export interface LatencyStats {
  count: number;
  medianMs: number | null;
  p95Ms: number | null;
}

/** outlet/player用のCSV本文を作る。 */
export function formatLatencyCsv(samples: readonly LatencySample[], startedAtMs: number): string {
  const header = 'timestamp_utc,elapsed_s,video_latency_ms,audio_latency_ms,audio_latency_phase_ms';
  const rows = samples.map((sample) => [
    new Date(sample.observedAtMs).toISOString(),
    ((sample.observedAtMs - startedAtMs) / 1_000).toFixed(3),
    formatValue(sample.videoLatencyMs),
    formatValue(sample.audioLatencyMs),
    formatValue(sample.audioLatencyPhaseMs ?? null),
  ].join(','));
  return [header, ...rows].join('\n') + '\n';
}

/** latency CSVを読み、壊れた行を明示的に拒否する。 */
export function parseLatencyCsv(csv: string): LatencySample[] {
  const rows = csv.trim().split(/\r?\n/);
  const modernHeader = 'timestamp_utc,elapsed_s,video_latency_ms,audio_latency_ms,audio_latency_phase_ms';
  const legacyHeader = 'timestamp_utc,elapsed_s,video_latency_ms,audio_latency_ms';
  if (rows.length === 0 || (rows[0] !== modernHeader && rows[0] !== legacyHeader)) {
    throw new Error('unexpected latency CSV header');
  }
  return rows.slice(1).filter(Boolean).map((row, index) => {
    const [timestamp, , video, audio, audioPhase] = row.split(',');
    const observedAtMs = Date.parse(timestamp ?? '');
    if (!Number.isFinite(observedAtMs)) throw new Error(`invalid timestamp at row ${index + 2}`);
    return { observedAtMs, videoLatencyMs: parseValue(video), audioLatencyMs: parseValue(audio), audioLatencyPhaseMs: parseValue(audioPhase) };
  });
}

/** CSVの最初の標本に保存したelapsed値から計測開始時刻を復元する。 */
export function inferLatencyStartedAtMs(csv: string): number | null {
  const rows = csv.trim().split(/\r?\n/);
  if (rows.length < 2 || !rows[0]!.startsWith('timestamp_utc,elapsed_s,video_latency_ms,audio_latency_ms')) return null;
  const [timestamp, elapsed] = rows[1]!.split(',');
  const observedAtMs = Date.parse(timestamp ?? '');
  const elapsedSeconds = Number(elapsed);
  return Number.isFinite(observedAtMs) && Number.isFinite(elapsedSeconds) ? observedAtMs - elapsedSeconds * 1_000 : null;
}

/** 映像遅延の中央値とnearest-rank p95を返す。 */
export function summarizeLatency(samples: readonly LatencySample[]): LatencyStats {
  const values = samples.flatMap((sample) => sample.videoLatencyMs === null ? [] : [sample.videoLatencyMs])
    .sort((left, right) => left - right);
  if (values.length === 0) return { count: 0, medianMs: null, p95Ms: null };
  return {
    count: values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
  };
}

/** 開始後に初めて映像遅延が閾値未満へ入った経過秒を返す。 */
export function firstBelowLatency(
  samples: readonly LatencySample[], startedAtMs: number, thresholdMs = 1_000
): number | null {
  const sample = samples.find((item) => item.videoLatencyMs !== null && item.videoLatencyMs < thresholdMs);
  return sample ? (sample.observedAtMs - startedAtMs) / 1_000 : null;
}

/** 観測したビープから直前のUTC秒境界までの遅延を返す。 */
export function latencyFromSecondBoundary(observedAtMs: number): number {
  const remainder = observedAtMs % 1_000;
  return remainder >= 0 ? remainder : remainder + 1_000;
}

/** 最初の30秒と1分単位の集計をMarkdown表へ整形する。 */
export function formatSummary(
  outlet: readonly LatencySample[], player: readonly LatencySample[] | null, startedAtMs: number, sender: readonly SenderSample[] | null = null,
  profileSwitches: readonly ProfileSwitch[] | null = null,
): string {
  const sections = [formatSeries('RTSPT 出口', outlet, startedAtMs)];
  if (player) sections.push(formatSeries('VRChat プレイヤー', player, startedAtMs));
  if (sender) {
    // sender.csvはrun中の生counterを保存し、summaryは再集計可能な差分値だけを追加する。
    sections.push(formatSenderSummary(sender));
  }
  if (profileSwitches) sections.push(formatProfileIntervals(outlet, player, sender, profileSwitches));
  return ['# 遅延計測サマリー', '', ...sections].join('\n');
}

function formatProfileIntervals(
  outlet: readonly LatencySample[], player: readonly LatencySample[] | null, sender: readonly SenderSample[] | null,
  switches: readonly ProfileSwitch[]
): string {
  const outletSegments = splitByProfile(outlet, switches, 15);
  const playerSegments = player ? splitByProfile(player, switches, 15) : null;
  const senderSegments = sender ? splitByProfile(sender, switches, 15) : null;
  const rows = outletSegments.map((segment, index) => formatProfileRow(
    profileIntervalLabel(segment, index), segment.samples, playerSegments?.[index]?.samples ?? null, senderSegments?.[index]?.samples ?? null,
  ));
  for (const profile of ['quality', 'realtime'] as const) {
    const pooledSenderSegments = senderSegments?.filter((segment) => segment.profile === profile) ?? null;
    rows.push(formatProfileRow(
      `${profile}（プール）`, poolProfileSegments(outletSegments, profile), playerSegments ? poolProfileSegments(playerSegments, profile) : null,
      pooledSenderSegments ? poolProfileSegments(pooledSenderSegments, profile) : null,
      pooledSenderSegments ? summarizeSenderSegments(pooledSenderSegments) : null,
    ));
  }
  return [
    '## プロファイル区間別', '', '- 各切替直後の15秒はWebRTC送出設定の過渡として除外しています。',
    '| 区間 | RTSPT median / p95 / n | VRChat median / p95 / n | 送出 fps | 平均ビットレート bps | 平均 QP | 最頻解像度 |',
    '|---|---|---|---:|---:|---:|---|', ...rows, '',
  ].join('\n');
}

function profileIntervalLabel(segment: ProfileSegment<LatencySample>, index: number): string {
  const start = segment.startedAtMs === null ? '-' : new Date(segment.startedAtMs).toISOString();
  const end = segment.endedAtMs === null ? '終了' : new Date(segment.endedAtMs).toISOString();
  return `${index + 1}. ${segment.profile} (${start} 〜 ${end})`;
}

function formatProfileRow(
  label: string, outlet: readonly LatencySample[], player: readonly LatencySample[] | null, sender: readonly SenderSample[] | null,
  senderStatsOverride: SenderIntervalStats | null = null,
): string {
  const outletStats = summarizeLatency(outlet);
  const playerStats = player ? summarizeLatency(player) : null;
  const senderStats = senderStatsOverride ?? (sender ? summarizeSenderInterval(sender) : null);
  return `| ${label} | ${formatLatencyStats(outletStats)} | ${playerStats ? formatLatencyStats(playerStats) : 'なし'} | ${formatDecimal(senderStats?.framesPerSecond, 2)} | ${formatDecimal(senderStats?.bitrateBps, 0)} | ${formatDecimal(senderStats?.averageQp, 2)} | ${senderStats?.resolution ?? 'n/a'} |`;
}

function formatLatencyStats(stats: LatencyStats): string {
  return `${formatValue(stats.medianMs)} / ${formatValue(stats.p95Ms)} / ${stats.count}`;
}

interface SenderIntervalStats { framesPerSecond: number | null; bitrateBps: number | null; averageQp: number | null; resolution: string | null }

function summarizeSenderInterval(samples: readonly SenderSample[]): SenderIntervalStats {
  if (samples.length < 2) return { framesPerSecond: null, bitrateBps: null, averageQp: null, resolution: modeResolution(samples) };
  const ordered = [...samples].sort((left, right) => left.observedAtMs - right.observedAtMs);
  const first = ordered[0]!;
  const last = ordered.at(-1)!;
  const elapsedSeconds = (last.observedAtMs - first.observedAtMs) / 1_000;
  const frames = last.framesEncoded - first.framesEncoded;
  if (elapsedSeconds <= 0 || frames < 0 || last.bytesSent < first.bytesSent || last.qpSum < first.qpSum) {
    return { framesPerSecond: null, bitrateBps: null, averageQp: null, resolution: modeResolution(samples) };
  }
  return {
    framesPerSecond: frames / elapsedSeconds,
    bitrateBps: (last.bytesSent - first.bytesSent) * 8 / elapsedSeconds,
    averageQp: frames > 0 ? (last.qpSum - first.qpSum) / frames : null,
    resolution: modeResolution(samples),
  };
}

function summarizeSenderSegments(segments: readonly ProfileSegment<SenderSample>[]): SenderIntervalStats {
  const summaries = segments.map((segment) => ({ samples: segment.samples, stats: summarizeSenderInterval(segment.samples) }));
  const valid = summaries.filter(({ stats }) => stats.framesPerSecond !== null && stats.bitrateBps !== null);
  const elapsedSeconds = valid.reduce((total, { samples }) => total + senderElapsedSeconds(samples), 0);
  const frames = valid.reduce((total, { samples }) => total + senderFrames(samples), 0);
  const bytes = valid.reduce((total, { samples }) => total + senderBytes(samples), 0);
  const qp = valid.reduce((total, { samples }) => total + senderQp(samples), 0);
  return {
    framesPerSecond: elapsedSeconds > 0 ? frames / elapsedSeconds : null,
    bitrateBps: elapsedSeconds > 0 ? bytes * 8 / elapsedSeconds : null,
    averageQp: frames > 0 ? qp / frames : null,
    resolution: modeResolution(summaries.flatMap(({ samples }) => samples)),
  };
}

function senderElapsedSeconds(samples: readonly SenderSample[]): number {
  if (samples.length < 2) return 0;
  const ordered = [...samples].sort((left, right) => left.observedAtMs - right.observedAtMs);
  return Math.max(0, (ordered.at(-1)!.observedAtMs - ordered[0]!.observedAtMs) / 1_000);
}

function senderFrames(samples: readonly SenderSample[]): number { return senderCounterDelta(samples, 'framesEncoded'); }
function senderBytes(samples: readonly SenderSample[]): number { return senderCounterDelta(samples, 'bytesSent'); }
function senderQp(samples: readonly SenderSample[]): number { return senderCounterDelta(samples, 'qpSum'); }
function senderCounterDelta(samples: readonly SenderSample[], field: 'framesEncoded' | 'bytesSent' | 'qpSum'): number {
  const ordered = [...samples].sort((left, right) => left.observedAtMs - right.observedAtMs);
  return samples.length < 2 ? 0 : ordered.at(-1)![field] - ordered[0]![field];
}

function modeResolution(samples: readonly SenderSample[]): string | null {
  const counts = new Map<string, number>();
  for (const sample of samples) if (sample.frameWidth !== null && sample.frameHeight !== null) {
    const resolution = `${sample.frameWidth}x${sample.frameHeight}`;
    counts.set(resolution, (counts.get(resolution) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] ?? null;
}

function formatDecimal(value: number | null | undefined, digits: number): string {
  return value === null || value === undefined || !Number.isFinite(value) ? 'n/a' : value.toFixed(digits);
}

function formatSeries(name: string, samples: readonly LatencySample[], startedAtMs: number): string {
  const buckets: Array<[string, LatencySample[]]> = [
    ['開始後 30 秒', samples.filter((sample) => sample.observedAtMs - startedAtMs < 30_000)],
  ];
  const lastElapsed = Math.max(0, ...samples.map((sample) => sample.observedAtMs - startedAtMs));
  for (let minute = 0; minute <= Math.floor(lastElapsed / 60_000); minute += 1) {
    buckets.push([`${minute + 1} 分`, samples.filter((sample) => {
      const elapsed = sample.observedAtMs - startedAtMs;
      return elapsed >= minute * 60_000 && elapsed < (minute + 1) * 60_000;
    })]);
  }
  const table = buckets.map(([label, bucket]) => {
    const stats = summarizeLatency(bucket);
    return `| ${label} | ${stats.count} | ${formatValue(stats.medianMs)} | ${formatValue(stats.p95Ms)} |`;
  });
  const firstBelow = firstBelowLatency(samples, startedAtMs);
  const av = avDifference(samples);
  return [
    `## ${name}`, '', '| 区間 | 映像標本 | median ms | p95 ms |', '|---|---:|---:|---:|', ...table,
    '', `- 最初に 1 秒未満へ入った時刻: ${firstBelow === null ? '未検出' : `${firstBelow.toFixed(3)} 秒`}`,
    `- A/V 差（audio - video、絶対値を復元できた近接標本）: ${av === null ? '標本なし' : `${av.toFixed(1)} ms`}`, '',
  ].join('\n');
}

function avDifference(samples: readonly LatencySample[]): number | null {
  const videos = samples.filter((sample): sample is LatencySample & { videoLatencyMs: number } => sample.videoLatencyMs !== null);
  const differences = samples.flatMap((audio) => {
    if (audio.audioLatencyMs === null || videos.length === 0) return [];
    const nearest = videos.reduce((best, candidate) => Math.abs(candidate.observedAtMs - audio.observedAtMs) < Math.abs(best.observedAtMs - audio.observedAtMs) ? candidate : best);
    return Math.abs(nearest.observedAtMs - audio.observedAtMs) <= 1_000 ? [audio.audioLatencyMs - nearest.videoLatencyMs] : [];
  }).sort((left, right) => left - right);
  return differences.length ? percentile(differences, 0.5) : null;
}

function percentile(values: readonly number[], ratio: number): number {
  return values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)]!;
}

function parseValue(value: string | undefined): number | null {
  if (value === '' || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error('invalid latency value');
  return parsed;
}

function formatValue(value: number | null): string {
  return value === null ? '' : value.toFixed(3);
}
import { formatSenderSummary, type SenderSample } from './latency-probe-quality';
import { poolProfileSegments, splitByProfile, type ProfileSegment, type ProfileSwitch } from './latency-probe-profile-analysis';
