import { describe, expect, test } from 'bun:test';

import {
  firstBelowLatency,
  formatLatencyCsv,
  formatSummary,
  inferLatencyStartedAtMs,
  latencyFromSecondBoundary,
  parseLatencyCsv,
  summarizeLatency,
  type LatencySample,
} from '../../scripts/latency-probe-analysis';
import {
  BLOCK_GRID_SIZE,
  bandPassOneKilohertz,
  compensateClockOffset,
  decodeBlockCode,
  decodeBlockCodeFrame,
  detectBeepOnsets,
  detectIdentifiedBeeps,
  decodeMonoWav,
  encodeBlockCode,
  encodeMonoWav,
} from '../../scripts/latency-probe-codec';
import { parseLatencyProbeArgs } from '../../scripts/latency-probe';
import { resolveAbsoluteAudioLatency, shouldLogDecodeFailure } from '../../scripts/latency-probe-observe';

function rasterize(timestampMs: number, cell = 20): { rgb: Uint8Array; width: number; height: number } {
  const width = BLOCK_GRID_SIZE * cell + 40;
  const height = BLOCK_GRID_SIZE * cell + 40;
  const rgb = new Uint8Array(width * height * 3).fill(20);
  const grid = encodeBlockCode(timestampMs);
  for (let y = 0; y < BLOCK_GRID_SIZE; y += 1) for (let x = 0; x < BLOCK_GRID_SIZE; x += 1) {
    const color = grid[y]![x] ? 255 : 0;
    for (let py = 0; py < cell; py += 1) for (let px = 0; px < cell; px += 1) {
      const offset = ((y * cell + py + 20) * width + x * cell + px + 20) * 3;
      rgb[offset] = color; rgb[offset + 1] = color; rgb[offset + 2] = color;
    }
  }
  return { rgb, width, height };
}

describe('latency block code', () => {
  test('48 bit時刻をchecksum付きで往復し、改ざんを拒否する', () => {
    const grid = encodeBlockCode(1_756_700_123_456);
    expect(decodeBlockCode(grid)).toBe(1_756_700_123_456);
    grid[2]![2] = !grid[2]![2];
    expect(decodeBlockCode(grid)).toBeNull();
  });

  test('同期パターンを探索してRGB合成フレームから時刻を復号する', () => {
    const frame = rasterize(1_756_700_123_456);
    expect(decodeBlockCodeFrame(frame.rgb, frame.width, frame.height)).toBe(1_756_700_123_456);
  });

  test('合成PCMの1kHzビープ立ち上がりを検出する', () => {
    const samples = new Float32Array(4_800).fill(0.002);
    for (let index = 1_200; index < 3_600; index += 1) samples[index] += Math.sin(2 * Math.PI * 1_000 * index / 48_000) * 0.1;
    expect(detectBeepOnsets(samples, 48_000)[0]).toBeGreaterThanOrEqual(960);
    expect(detectBeepOnsets(samples, 48_000)[0]).toBeLessThanOrEqual(1_440);
  });

  test('合成PCMの秒識別ビープを8帯域から復号する', () => {
    const samples = new Float32Array(48_000);
    for (let index = 12_000; index < 14_400; index += 1) samples[index] = Math.sin(2 * Math.PI * 1_100 * index / 48_000) * 0.2;
    const detected = detectIdentifiedBeeps(samples, 48_000)[0]!;
    expect(detected.secondMod8).toBe(5);
    expect(detected.onset).toBeGreaterThanOrEqual(11_040);
    expect(detected.onset).toBeLessThanOrEqual(12_480);
  });

  test('映像近接標本で8秒内の音声送出秒を絶対遅延へ対応付ける', () => {
    const observed = 8_005_300;
    expect(resolveAbsoluteAudioLatency(observed, 4, [{ observedAtMs: observed - 400, videoLatencyMs: 1_200, audioLatencyMs: null }])).toBe(1_300);
    expect(resolveAbsoluteAudioLatency(observed, 0, [])).toBeNull();
  });

  test('バンドパスは1kHzを通し、WAV往復後もビープを検出する', () => {
    const samples = new Float32Array(4_800);
    for (let index = 1_200; index < 3_600; index += 1) samples[index] = Math.sin(2 * Math.PI * 1_000 * index / 48_000) * 0.25;
    const filtered = bandPassOneKilohertz(samples, 48_000);
    expect(Math.max(...filtered.map(Math.abs))).toBeGreaterThan(0.05);
    const decoded = decodeMonoWav(encodeMonoWav(samples, 48_000));
    expect(detectBeepOnsets(decoded.samples, decoded.sampleRate)).not.toEqual([]);
  });

  test('Windows時計差をMac基準へ補正する', () => {
    expect(compensateClockOffset(10_250, 250)).toBe(10_000);
  });

  test('復号失敗ログを指定間隔に間引く', () => {
    expect(shouldLogDecodeFailure(10_000, null)).toBe(true);
    expect(shouldLogDecodeFailure(14_999, 10_000)).toBe(false);
    expect(shouldLogDecodeFailure(15_000, 10_000)).toBe(true);
  });
});

describe('latency CSV analysis', () => {
  const startedAtMs = 1_756_700_000_000;
  const samples: LatencySample[] = [
    { observedAtMs: startedAtMs + 1_000, videoLatencyMs: 1_200, audioLatencyMs: 1_300 },
    { observedAtMs: startedAtMs + 31_000, videoLatencyMs: 900, audioLatencyMs: 1_000 },
    { observedAtMs: startedAtMs + 61_000, videoLatencyMs: 100, audioLatencyMs: 150 },
  ];

  test('CSVを往復し、median/p95と最初の1秒未満を集計する', () => {
    expect(parseLatencyCsv(formatLatencyCsv(samples, startedAtMs))).toEqual(samples.map((sample) => ({ ...sample, audioLatencyPhaseMs: null })));
    expect(inferLatencyStartedAtMs(formatLatencyCsv(samples, startedAtMs))).toBe(startedAtMs);
    expect(summarizeLatency(samples)).toEqual({ count: 3, medianMs: 900, p95Ms: 1_200 });
    expect(firstBelowLatency(samples, startedAtMs)).toBe(31);
    expect(latencyFromSecondBoundary(startedAtMs + 1_234.5)).toBe(234.5);
  });

  test('summaryに開始直後、分単位、A/V差を含める', () => {
    const summary = formatSummary(samples, null, startedAtMs);
    expect(summary).toContain('開始後 30 秒');
    expect(summary).toContain('1 分');
    expect(summary).toContain('A/V 差');
  });

  test('近接した別標本の音声と映像からA/V差を集計する', () => {
    const summary = formatSummary([
      { observedAtMs: startedAtMs + 1_000, videoLatencyMs: 600, audioLatencyMs: null },
      { observedAtMs: startedAtMs + 1_120, videoLatencyMs: null, audioLatencyMs: 750 },
    ], null, startedAtMs);
    expect(summary).toContain('A/V 差（audio - video、絶対値を復元できた近接標本）: 150.0 ms');
  });
});

describe('latency probe CLI contract', () => {
  test('run/source/analyzeの凍結された形を検証する', () => {
    const run = parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'http://127.0.0.1:0/latency-source.html?tones=1']);
    expect(run.command).toBe('run');
    expect(parseLatencyProbeArgs(['source', '--url', 'https://example.test/']).command).toBe('source');
    expect(parseLatencyProbeArgs(['analyze', 'docs/tmp/latency/run']).command).toBe('analyze');
    expect(parseLatencyProbeArgs(['login']).command).toBe('login');
    const enabled = parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--notify-discord', '123456789012345', '--server-snap', 'relay-1.example']);
    expect(enabled).toMatchObject({ command: 'run', options: { notifyDiscordChannelId: '123456789012345', serverSnapHost: 'relay-1.example', player: null } });
  });

  test('runの必須引数とplayer値をfail-closedする', () => {
    expect(() => parseLatencyProbeArgs(['run', '--minutes', '2'])).toThrow('--source is required');
    expect(() => parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--player', 'other'])).toThrow('win2022');
    expect(() => parseLatencyProbeArgs(['run', '--minutes', '0', '--source', 'https://example.test'])).toThrow('between 1 and 120');
    expect(() => parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--server-snap', '-host'])).toThrow('ssh host');
  });
});
