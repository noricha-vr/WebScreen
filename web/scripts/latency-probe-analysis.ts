/** 1標本分の遅延値。 */
export interface LatencySample {
  observedAtMs: number;
  videoLatencyMs: number | null;
  audioLatencyMs: number | null;
}

/** CSVから再生成可能な集計値。 */
export interface LatencyStats {
  count: number;
  medianMs: number | null;
  p95Ms: number | null;
}

/** outlet/player用のCSV本文を作る。 */
export function formatLatencyCsv(samples: readonly LatencySample[], startedAtMs: number): string {
  const header = 'timestamp_utc,elapsed_s,video_latency_ms,audio_latency_ms';
  const rows = samples.map((sample) => [
    new Date(sample.observedAtMs).toISOString(),
    ((sample.observedAtMs - startedAtMs) / 1_000).toFixed(3),
    formatValue(sample.videoLatencyMs),
    formatValue(sample.audioLatencyMs),
  ].join(','));
  return [header, ...rows].join('\n') + '\n';
}

/** latency CSVを読み、壊れた行を明示的に拒否する。 */
export function parseLatencyCsv(csv: string): LatencySample[] {
  const rows = csv.trim().split(/\r?\n/);
  if (rows.length === 0 || rows[0] !== 'timestamp_utc,elapsed_s,video_latency_ms,audio_latency_ms') {
    throw new Error('unexpected latency CSV header');
  }
  return rows.slice(1).filter(Boolean).map((row, index) => {
    const [timestamp, , video, audio] = row.split(',');
    const observedAtMs = Date.parse(timestamp ?? '');
    if (!Number.isFinite(observedAtMs)) throw new Error(`invalid timestamp at row ${index + 2}`);
    return { observedAtMs, videoLatencyMs: parseValue(video), audioLatencyMs: parseValue(audio) };
  });
}

/** CSVの最初の標本に保存したelapsed値から計測開始時刻を復元する。 */
export function inferLatencyStartedAtMs(csv: string): number | null {
  const rows = csv.trim().split(/\r?\n/);
  if (rows.length < 2 || rows[0] !== 'timestamp_utc,elapsed_s,video_latency_ms,audio_latency_ms') return null;
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

/** 最初の30秒と1分単位の集計をMarkdown表へ整形する。 */
export function formatSummary(
  outlet: readonly LatencySample[], player: readonly LatencySample[] | null, startedAtMs: number
): string {
  const sections = [formatSeries('RTSPT 出口', outlet, startedAtMs)];
  if (player) sections.push(formatSeries('VRChat プレイヤー', player, startedAtMs));
  return ['# 遅延計測サマリー', '', ...sections].join('\n');
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
    `- A/V 差（audio - video、同一標本）: ${av === null ? '標本なし' : `${av.toFixed(1)} ms`}`, '',
  ].join('\n');
}

function avDifference(samples: readonly LatencySample[]): number | null {
  const differences = samples.flatMap((sample) => sample.audioLatencyMs === null || sample.videoLatencyMs === null
    ? [] : [sample.audioLatencyMs - sample.videoLatencyMs]).sort((left, right) => left - right);
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
