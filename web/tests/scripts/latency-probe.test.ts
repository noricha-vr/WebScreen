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
import { poolProfileSegments, splitByProfile, type ProfileSwitch } from '../../scripts/latency-probe-profile-analysis';
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
import { screenShareUrl } from '../../scripts/latency-probe-run';
import { parseFreezeLog, type SenderSample } from '../../scripts/latency-probe-quality';

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

function rasterizeWide(timestampMs: number, cell = 40): { rgb: Uint8Array; width: number; height: number } {
  const width = 1280, height = 720, x0 = Math.floor((width - BLOCK_GRID_SIZE * cell) / 2), y0 = Math.floor((height - BLOCK_GRID_SIZE * cell) / 2);
  const rgb = new Uint8Array(width * height * 3).fill(20);
  const grid = encodeBlockCode(timestampMs);
  for (let y = 0; y < BLOCK_GRID_SIZE; y += 1) for (let x = 0; x < BLOCK_GRID_SIZE; x += 1) {
    const color = grid[y]![x] ? 255 : 0;
    for (let py = 0; py < cell; py += 1) for (let px = 0; px < cell; px += 1) {
      const offset = ((y0 + y * cell + py) * width + x0 + x * cell + px) * 3;
      rgb[offset] = color; rgb[offset + 1] = color; rgb[offset + 2] = color;
    }
  }
  return { rgb, width, height };
}

function scaleNearest(frame: { rgb: Uint8Array; width: number; height: number }, width: number, height: number): { rgb: Uint8Array; width: number; height: number } {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const sourceX = Math.min(frame.width - 1, Math.floor(x * frame.width / width));
    const sourceY = Math.min(frame.height - 1, Math.floor(y * frame.height / height));
    rgb.set(frame.rgb.slice((sourceY * frame.width + sourceX) * 3, (sourceY * frame.width + sourceX + 1) * 3), (y * width + x) * 3);
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

  test('960x540および640x360へ縮小してもブロックコードを復号する', () => {
    const timestamp = 1_756_700_123_456;
    const original = rasterizeWide(timestamp);
    for (const [width, height] of [[960, 540], [640, 360]] as const) {
      const frame = scaleNearest(original, width, height);
      expect(decodeBlockCodeFrame(frame.rgb, frame.width, frame.height)).toBe(timestamp);
    }
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

  test('2回の切替を3区間に分け、切替後15秒の過渡標本を除外する', () => {
    const switches: ProfileSwitch[] = [
      { observedAtMs: startedAtMs, elapsedSeconds: 0, profile: 'quality', maxBitrate: 1_200_000 },
      { observedAtMs: startedAtMs + 60_000, elapsedSeconds: 60, profile: 'realtime', maxBitrate: 1_500_000 },
      { observedAtMs: startedAtMs + 120_000, elapsedSeconds: 120, profile: 'quality', maxBitrate: 1_200_000 },
    ];
    const samples = [10, 60, 74, 75, 90, 120, 134, 135, 150].map((seconds) => ({ observedAtMs: startedAtMs + seconds * 1_000 }));

    expect(splitByProfile(samples, switches, 15).map((segment) => segment.samples.map((sample) => (sample.observedAtMs - startedAtMs) / 1_000))).toEqual([
      [10], [75, 90], [135, 150],
    ]);
  });

  test('切替なしは1区間のままにする', () => {
    const switches: ProfileSwitch[] = [{ observedAtMs: startedAtMs, elapsedSeconds: 0, profile: 'quality', maxBitrate: 1_200_000 }];
    const samples = [{ observedAtMs: startedAtMs + 5_000 }, { observedAtMs: startedAtMs + 30_000 }];

    expect(splitByProfile(samples, switches, 15)).toMatchObject([{ profile: 'quality', samples }]);
  });

  test('同一プロファイルの複数区間をプールする', () => {
    const switches: ProfileSwitch[] = [
      { observedAtMs: startedAtMs, elapsedSeconds: 0, profile: 'quality', maxBitrate: 1_200_000 },
      { observedAtMs: startedAtMs + 60_000, elapsedSeconds: 60, profile: 'realtime', maxBitrate: 1_500_000 },
      { observedAtMs: startedAtMs + 120_000, elapsedSeconds: 120, profile: 'quality', maxBitrate: 1_200_000 },
    ];
    const samples = [10, 75, 90, 135, 150].map((seconds) => ({ observedAtMs: startedAtMs + seconds * 1_000 }));
    const segments = splitByProfile(samples, switches, 15);

    expect(poolProfileSegments(segments, 'quality').map((sample) => (sample.observedAtMs - startedAtMs) / 1_000)).toEqual([10, 135, 150]);
    expect(poolProfileSegments(segments, 'realtime').map((sample) => (sample.observedAtMs - startedAtMs) / 1_000)).toEqual([75, 90]);
  });

  test('送出側のプールは別プロファイルをまたぐcounter差分を混ぜない', () => {
    const switches: ProfileSwitch[] = [
      { observedAtMs: startedAtMs, elapsedSeconds: 0, profile: 'quality', maxBitrate: 1_200_000 },
      { observedAtMs: startedAtMs + 60_000, elapsedSeconds: 60, profile: 'realtime', maxBitrate: 1_500_000 },
      { observedAtMs: startedAtMs + 120_000, elapsedSeconds: 120, profile: 'quality', maxBitrate: 1_200_000 },
    ];
    const sender = [
      [0, 0, 0, 0], [10, 300, 300_000, 6_000], [75, 2_250, 2_250_000, 45_000],
      [90, 2_700, 2_700_000, 54_000], [135, 4_050, 4_050_000, 81_000], [150, 4_500, 4_500_000, 90_000],
    ].map(([seconds, framesEncoded, bytesSent, qpSum]) => ({
      observedAtMs: startedAtMs + seconds! * 1_000, framesPerSecond: 30, framesEncoded: framesEncoded!, keyFramesEncoded: 0,
      frameWidth: 1280, frameHeight: 720, bytesSent: bytesSent!, qpSum: qpSum!, totalEncodeTime: 0,
      qualityLimitationReason: null, qualityLimitationDurations: { none: null, cpu: null, bandwidth: null, other: null },
    } satisfies SenderSample));

    expect(formatSummary([], null, startedAtMs, sender, switches)).toContain('| quality（プール） |  /  / 0 | なし | 30.00 | 240000 | 20.00 | 1280x720 |');
  });
});

describe('latency probe CLI contract', () => {
  test('run/source/analyzeの凍結された形を検証する', () => {
    const run = parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'http://127.0.0.1:0/latency-source.html?tones=1']);
    expect(run.command).toBe('run');
    expect(parseLatencyProbeArgs(['source', '--url', 'https://example.test/', '--scroll', '240'])).toMatchObject({ command: 'source', scrollPixelsPerSecond: 240 });
    expect(parseLatencyProbeArgs(['analyze', 'docs/tmp/latency/run']).command).toBe('analyze');
    expect(parseLatencyProbeArgs(['login']).command).toBe('login');
    const enabled = parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--notify-discord', '123456789012345', '--server-snap', 'relay-1.example']);
    expect(enabled).toMatchObject({ command: 'run', options: { notifyDiscordChannelId: '123456789012345', serverSnapHost: 'relay-1.example', player: null } });
    expect(parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--video-profile', 'realtime', '--max-bitrate', '1500000', '--scroll', '240'])).toMatchObject({ command: 'run', options: { videoProfile: 'realtime', maxBitrate: 1_500_000, scrollPixelsPerSecond: 240 } });
    expect(parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--ab-cycle', '60', '--max-bitrate', '1500000'])).toMatchObject({ command: 'run', options: { videoProfile: 'quality', abCycleSeconds: 60, maxBitrate: 1_500_000 } });
  });

  test('共有タブへ渡す URL は http(s) かつ資格情報なしに限る', () => {
    for (const url of ['file:///etc/hosts', 'data:text/html,hi', 'https://user:pw@example.test/']) {
      expect(() => parseLatencyProbeArgs(['run', '--minutes', '1', '--source', url])).toThrow();
      expect(() => parseLatencyProbeArgs(['source', '--url', url])).toThrow();
    }
  });

  test('runの必須引数とplayer値をfail-closedする', () => {
    expect(() => parseLatencyProbeArgs(['run', '--minutes', '2'])).toThrow('--source is required');
    expect(() => parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--player', 'other'])).toThrow('win2022');
    expect(() => parseLatencyProbeArgs(['run', '--minutes', '0', '--source', 'https://example.test'])).toThrow('between 1 and 120');
    expect(() => parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--server-snap', '-host'])).toThrow('ssh host');
    expect(() => parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--max-bitrate', '1500000'])).toThrow('only valid');
    expect(() => parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--video-profile', 'realtime', '--max-bitrate', '999999'])).toThrow('1200000');
    expect(() => parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--ab-cycle', '59', '--max-bitrate', '1500000'])).toThrow('between 60 and 600');
    expect(() => parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--ab-cycle', '601', '--max-bitrate', '1500000'])).toThrow('between 60 and 600');
    expect(() => parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--ab-cycle', '60'])).toThrow('requires --max-bitrate');
    expect(() => parseLatencyProbeArgs(['source', '--url', 'https://example.test', '--scroll', '2001'])).toThrow('between 0 and 2000');
  });
});

describe('latency probe quality helpers', () => {
  test('freezedetectの開始・終了を窓内のfreezeとして集計する', () => {
    const log = '[freezedetect] lavfi.freezedetect.freeze_start: 1.25\n[freezedetect] lavfi.freezedetect.freeze_duration: 2.5\n[freezedetect] lavfi.freezedetect.freeze_end: 3.75';
    expect(parseFreezeLog(log, 10)).toEqual({ freezes: 1, freezeSeconds: 2.5 });
  });

  test('窓末尾で未閉鎖のfreezeを窓末尾まで集計する', () => {
    expect(parseFreezeLog('lavfi.freezedetect.freeze_start: 8.5', 10)).toEqual({ freezes: 1, freezeSeconds: 1.5 });
  });

  test('freezeが無いログは0として集計する', () => {
    expect(parseFreezeLog('frame=  42 fps=30', 10)).toEqual({ freezes: 0, freezeSeconds: 0 });
  });

  test('production画面共有URLはqualityでqueryなし、realtimeで設定2個だけにする', () => {
    const quality = new URL(screenShareUrl({ videoProfile: 'quality', maxBitrate: null }));
    expect(quality.search).toBe('');
    const realtime = new URL(screenShareUrl({ videoProfile: 'realtime', maxBitrate: 1_500_000 }));
    expect([...realtime.searchParams.entries()]).toEqual([
      ['video-profile', 'realtime'], ['video-max-bitrate', '1500000'],
    ]);
  });
});
