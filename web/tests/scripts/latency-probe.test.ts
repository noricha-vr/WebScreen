import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { formatProfileSwitchesCsv, parseProfileSwitchesCsv, poolProfileSegments, splitByProfile, type ProfileSwitch } from '../../scripts/latency-probe-profile-analysis';
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
import { requirePipe, resolveAbsoluteAudioLatency, shouldLogDecodeFailure } from '../../scripts/latency-probe-observe';
import { applyVideoProfile, cycleVideoProfiles, type VideoProfileEvaluator } from '../../scripts/latency-probe-profile';
import { analyzeDirectory, clearPreviousRunArtifacts, headersForRewrittenBody, rewriteWhipUrlHost, screenShareUrl, startControllerServer, syntheticHealthBody, validateReadHost, validateRunOptions } from '../../scripts/latency-probe-run';
import { NOTIFY_COMMAND_ENV, NOTIFY_STDERR_TRUNCATED_SUFFIX, buildNotifyArgv, notifyCommandTemplate, notifyStdinJson, notifyStreamUrl, parseCommandLine, warnNotifyCommandMissing, type NotifyChild, type NotifySpawn } from '../../scripts/latency-probe-notify';
import { parseFreezeLog, type SenderSample } from '../../scripts/latency-probe-quality';
import { recordingDeadlineSeconds } from '../../scripts/latency-probe-player';

const CONTROLLER_TOKEN = 'a'.repeat(64);

function controllerState(sourcePage: import('@playwright/test').Page | null = null) {
  return { sourcePage, sourceUrl: 'http://127.0.0.1:4321/', sourceServerUrl: 'http://127.0.0.1:4321/' };
}

function rawHttpRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let response = '';
    const socket = createConnection({ host: '127.0.0.1', port }, () => socket.write(request));
    socket.setEncoding('utf8');
    socket.setTimeout(2_000, () => socket.destroy(new Error('raw controller request timed out')));
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('close', () => resolve(response));
    socket.on('error', reject);
  });
}

describe('latency probe controller', () => {
  test.each([
    ['単純POSTでトークンなし', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'url=http%3A%2F%2F127.0.0.1%3A4321%2Fnext', 401],
    ['同じ長さの不一致トークン', { Authorization: `Bearer ${'b'.repeat(64)}`, 'Content-Type': 'application/json' }, JSON.stringify({ url: 'http://127.0.0.1:4321/next', scrollPixelsPerSecond: 0 }), 401],
    ['text/plain', { Authorization: `Bearer ${CONTROLLER_TOKEN}`, 'Content-Type': 'text/plain' }, JSON.stringify({ url: 'http://127.0.0.1:4321/next', scrollPixelsPerSecond: 0 }), 400],
    ['4 KB超', { Authorization: `Bearer ${CONTROLLER_TOKEN}`, 'Content-Type': 'application/json' }, 'x'.repeat(4 * 1024 + 1), 400],
  ])('%sの要求を拒否する', async (_caseName, headers, body, expectedStatus) => {
    const server = startControllerServer(controllerState(), CONTROLLER_TOKEN);
    try {
      const response = await fetch(new URL('/source', server.url), { method: 'POST', headers, body });
      expect(response.status).toBe(expectedStatus);
      expect(await response.text()).not.toContain(CONTROLLER_TOKEN);
    } finally { server.stop(true); }
  });

  test('Content-Lengthなしのchunked本文が4 KBを超えたら拒否する', async () => {
    const server = startControllerServer(controllerState(), CONTROLLER_TOKEN);
    const encoder = new TextEncoder();
    try {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(encoder.encode('x'.repeat(4 * 1024)));
        controller.enqueue(encoder.encode('x'));
        controller.close();
      } });
      const response = await fetch(new URL('/source', server.url), { method: 'POST', headers: { Authorization: `Bearer ${CONTROLLER_TOKEN}`, 'Content-Type': 'application/json' }, body });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain(CONTROLLER_TOKEN);
    } finally { server.stop(true); }
  });

  test.each([
    ['実本文より短い値', '1', '1x'],
    ['数値でない値', 'invalid', '1'],
  ])('偽装Content-Length（%s）を拒否する', async (_caseName, contentLength, body) => {
    const server = startControllerServer(controllerState(), CONTROLLER_TOKEN);
    try {
      if (server.port === undefined) throw new Error('controller TCP port is unavailable');
      const request = [
        'POST /source HTTP/1.1', `Host: 127.0.0.1:${server.port}`, `Authorization: Bearer ${CONTROLLER_TOKEN}`,
        'Content-Type: application/json', `Content-Length: ${contentLength}`, 'Connection: close', '', body,
      ].join('\r\n');
      const response = await rawHttpRequest(server.port, request);
      expect(response).toMatch(/^HTTP\/1\.1 400 /);
      expect(response).not.toContain(CONTROLLER_TOKEN);
    } finally { server.stop(true); }
  });

  test('正しいトークンとJSONなら共有タブを切り替える', async () => {
    const navigations: string[] = [];
    const sourcePage = { goto: async (url: string) => { navigations.push(url); return null; } } as unknown as import('@playwright/test').Page;
    const server = startControllerServer(controllerState(sourcePage), CONTROLLER_TOKEN);
    try {
      const response = await fetch(new URL('/source', server.url), {
        method: 'POST',
        headers: { Authorization: `bEaReR   ${CONTROLLER_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ url: 'http://127.0.0.1:4321/next', scrollPixelsPerSecond: 0 }),
      });
      expect(response.status).toBe(200);
      expect(navigations).toEqual(['http://127.0.0.1:4321/next']);
    } finally { server.stop(true); }
  });
});

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

/** latency-source.html と同じ傾斜エンベロープ（8 ms 立ち上がり / 48 ms まで保持 / 75 ms で 0）。 */
function beepEnvelope(elapsedSeconds: number): number {
  if (elapsedSeconds < 0.008) return elapsedSeconds / 0.008;
  if (elapsedSeconds <= 0.048) return 1;
  return Math.max(0, (0.075 - elapsedSeconds) / 0.027);
}

/** 定常音（各 -20 dBFS）へ毎秒 1 回の秒識別ビープ（-20 dBFS）を重ねた 8 秒の 48 kHz モノラル PCM。 */
function synthesizeBeepsOverSteadyTones(steadyHz: readonly number[]): { samples: Float32Array; onsets: number[] } {
  const sampleRate = 48_000;
  const amplitude = 0.1;
  const samples = new Float32Array(sampleRate * 8);
  for (const frequency of steadyHz) {
    for (let index = 0; index < samples.length; index += 1) samples[index] += Math.sin(2 * Math.PI * frequency * index / sampleRate) * amplitude;
  }
  const onsets: number[] = [];
  for (let secondMod8 = 0; secondMod8 < 8; secondMod8 += 1) {
    // 検出の hop（10 ms）に揃えた位置へ置き、窓中心を onset とする既知のバイアスを 15 ms に固定する。
    const onset = sampleRate / 2 + secondMod8 * sampleRate;
    onsets.push(onset);
    for (let index = 0; index < Math.round(sampleRate * 0.075); index += 1) {
      samples[onset + index] += Math.sin(2 * Math.PI * (600 + 100 * secondMod8) * index / sampleRate) * amplitude * beepEnvelope(index / sampleRate);
    }
  }
  return { samples, onsets };
}

function withLiveVideoSender(trackId = 'sender-a'): { evaluator: VideoProfileEvaluator; parameters: RTCRtpSendParameters; setReadbackMismatch(value: boolean): void; replaceSender(track: string): void; restore(): void } {
  let parameters = { encodings: [{ scaleResolutionDownBy: 2 }] } as RTCRtpSendParameters;
  let mismatch = false;
  const track = { kind: 'video', readyState: 'live', id: trackId, contentHint: '' } as MediaStreamTrack;
  const sender = {
    track,
    getParameters: () => mismatch ? { ...parameters, encodings: [{ ...parameters.encodings?.[0], maxBitrate: 1 }] } : parameters,
    setParameters: async (next: RTCRtpSendParameters) => { parameters = next; },
  } as unknown as RTCRtpSender;
  const connection = { connectionState: 'connected', getSenders: () => [sender] } as unknown as RTCPeerConnection;
  const global = globalThis as { window: Window & typeof globalThis };
  const previous = global.window;
  global.window = { __webscreenHarnessPeerConnections: [connection] } as unknown as Window & typeof globalThis;
  return {
    evaluator: { evaluate: async (pageFunction, argument) => pageFunction(argument) },
    parameters,
    setReadbackMismatch: (value) => { mismatch = value; },
    replaceSender: (nextTrackId) => { Object.assign(track, { id: nextTrackId }); },
    restore: () => { global.window = previous; },
  };
}

describe('latency probe video profiles', () => {
  test('realtimeではscaleを外し、qualityへ戻すと1を読み戻せる', async () => {
    const harness = withLiveVideoSender();
    try {
      await applyVideoProfile(harness.evaluator, 'realtime', 1_500_000, 1_000);
      expect(harness.parameters.encodings?.[0]?.scaleResolutionDownBy).toBeUndefined();
      await applyVideoProfile(harness.evaluator, 'quality', 1_500_000, 1_000);
      expect(harness.parameters.encodings?.[0]?.scaleResolutionDownBy).toBe(1);
    } finally { harness.restore(); }
  });

  test('senderの読み戻しが不一致ならプロファイル変更を拒否する', async () => {
    const harness = withLiveVideoSender();
    try {
      harness.setReadbackMismatch(true);
      await expect(applyVideoProfile(harness.evaluator, 'realtime', 1_500_000, 1_000)).rejects.toThrow('readback mismatch');
    } finally { harness.restore(); }
  });

  test('abort済みまたは終了済みの周期はevaluateを呼ばない', async () => {
    let evaluations = 0;
    const evaluator: VideoProfileEvaluator = { evaluate: async () => { evaluations += 1; throw new Error('must not evaluate'); } };
    const initial: ProfileSwitch = { observedAtMs: 1_000, elapsedSeconds: 0, profile: 'quality', maxBitrate: 1_200_000 };
    const abortedDuringWait = new AbortController();
    let now = 1_000;
    await cycleVideoProfiles(evaluator, tmpdir(), 1_000, 7_000, initial, 1_500_000, 60, abortedDuringWait.signal, {
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; abortedDuringWait.abort(); },
    });
    await cycleVideoProfiles(evaluator, tmpdir(), 1_000, 1_000, initial, 1_500_000, 60);
    expect(evaluations).toBe(0);
  });

  test('公開境界は不正なプロファイル・bitrate・周期を副作用前に拒否する', async () => {
    const evaluator: VideoProfileEvaluator = { evaluate: async () => { throw new Error('must not evaluate'); } };
    await expect(applyVideoProfile(evaluator, 'other' as 'quality', 1_500_000, 1_000)).rejects.toThrow('video profile');
    expect(() => validateRunOptions({ minutes: 1, source: 'https://example.test', player: null, profileDir: '/tmp/profile', outDir: '/tmp/out', videoProfile: 'quality', maxBitrate: 999_999, abCycleSeconds: null, scrollPixelsPerSecond: 0, outletQualitySeconds: 20, notifyDiscordChannelId: null, serverSnapHost: null, streamId: null, nodeHost: null, readHost: null })).toThrow('maxBitrate');
    expect(() => validateRunOptions({ minutes: 1, source: 'https://example.test', player: null, profileDir: '/tmp/profile', outDir: '/tmp/out', videoProfile: 'quality', maxBitrate: 1_500_000, abCycleSeconds: 59, scrollPixelsPerSecond: 0, outletQualitySeconds: 20, notifyDiscordChannelId: null, serverSnapHost: null, streamId: null, nodeHost: null, readHost: null })).toThrow('cycleSeconds');
    // CLI を通さず runLatencyProbe を直接呼ぶ経路でも、通知先 ID を CLI と同じ規則で弾く
    expect(() => validateRunOptions({ minutes: 1, source: 'https://example.test', player: null, profileDir: '/tmp/profile', outDir: '/tmp/out', videoProfile: 'quality', maxBitrate: null, abCycleSeconds: null, scrollPixelsPerSecond: 0, outletQualitySeconds: 20, notifyDiscordChannelId: '12345', serverSnapHost: null, streamId: null, nodeHost: null, readHost: null })).toThrow('notify-discord');
  });

  test('sender差し替え時は5秒ポーリングで同じプロファイルを再適用する', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latency-profile-'));
    const harness = withLiveVideoSender();
    let now = 1_000;
    try {
      const initial = await applyVideoProfile(harness.evaluator, 'quality', 1_500_000, now);
      await writeFile(join(directory, 'profile-switches.csv'), 'timestamp_utc,elapsed_s,profile,max_bitrate,action\n');
      const switches = await cycleVideoProfiles(harness.evaluator, directory, now, 7_000, initial, 1_500_000, 60, undefined, {
        now: () => now,
        sleep: async (milliseconds) => { now += milliseconds; if (now >= 6_000) harness.replaceSender('sender-b'); },
      });
      expect(switches.map((item) => item.action)).toEqual(['applied', 'reapplied']);
      expect(await readFile(join(directory, 'profile-switches.csv'), 'utf8')).toContain(',reapplied');
    } finally { harness.restore(); await rm(directory, { recursive: true, force: true }); }
  });
});

describe('latency probe output isolation', () => {
  test('再利用する出力先から前runの解析対象成果物だけを除去する', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latency-artifacts-'));
    try {
      await Promise.all(['profile-switches.csv', 'player.csv', 'player-error.md', 'cleanup-error.md', 'sender-error.md', 'outlet.csv', 'keep.txt'].map((name) => writeFile(join(directory, name), 'old')));
      await clearPreviousRunArtifacts(directory);
      await expect(readFile(join(directory, 'profile-switches.csv'), 'utf8')).rejects.toThrow();
      await expect(readFile(join(directory, 'player.csv'), 'utf8')).rejects.toThrow();
      expect(await readFile(join(directory, 'keep.txt'), 'utf8')).toBe('old');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test('analyzeは別runのprofile切替履歴を拒否する', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'latency-analyze-'));
    const startedAtMs = 1_756_700_000_000;
    try {
      await writeFile(join(directory, 'outlet.csv'), formatLatencyCsv([{ observedAtMs: startedAtMs, videoLatencyMs: 100, audioLatencyMs: null }], startedAtMs));
      await writeFile(join(directory, 'profile-switches.csv'), `timestamp_utc,elapsed_s,profile,max_bitrate,action\n${new Date(startedAtMs + 60_001).toISOString()},0.000,quality,1200000,applied\n`);
      await expect(analyzeDirectory(directory)).rejects.toThrow('within 60 seconds');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

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

  test.each([
    ['現行の 220/330 Hz', [220, 330]],
    ['旧 440/880 Hz（倍音がビープ帯域に近い最悪ケース）', [440, 880]],
  ] as const)('定常音 %s に重ねても8個の秒識別ビープを取り違えず検出する', (_label, steadyHz) => {
    const { samples, onsets } = synthesizeBeepsOverSteadyTones(steadyHz);
    const detected = detectIdentifiedBeeps(samples, 48_000);

    expect(detected.map((beep) => beep.secondMod8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const [index, beep] of detected.entries()) expect(Math.abs(beep.onset - onsets[index]!)).toBeLessThanOrEqual(720);
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

  test('再適用イベントをCSVへ保存し、従来4列CSVも解析できる', () => {
    const reapplied: ProfileSwitch = { observedAtMs: startedAtMs, elapsedSeconds: 0, profile: 'quality', maxBitrate: 1_200_000, action: 'reapplied' };
    expect(parseProfileSwitchesCsv(formatProfileSwitchesCsv([reapplied]))[0]?.action).toBe('reapplied');
    expect(parseProfileSwitchesCsv(`timestamp_utc,elapsed_s,profile,max_bitrate\n${new Date(startedAtMs).toISOString()},0.000,quality,1200000\n`)[0]?.action).toBe('applied');
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

  test('過渡除外で標本0の区間もプロファイル再集計に残す', () => {
    const switches: ProfileSwitch[] = [
      { observedAtMs: startedAtMs, elapsedSeconds: 0, profile: 'quality', maxBitrate: 1_200_000 },
      { observedAtMs: startedAtMs + 60_000, elapsedSeconds: 60, profile: 'realtime', maxBitrate: 1_500_000 },
    ];
    const outlet = [{ observedAtMs: startedAtMs + 10_000, videoLatencyMs: 100, audioLatencyMs: null }, { observedAtMs: startedAtMs + 65_000, videoLatencyMs: 100, audioLatencyMs: null }];

    expect(splitByProfile(outlet, switches, 15)[1]?.samples).toEqual([]);
    expect(formatSummary(outlet, null, startedAtMs, null, switches)).toContain('| 2. realtime');
    expect(formatSummary(outlet, null, startedAtMs, null, switches)).toContain('|  /  / 0 |');
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
    expect(enabled).toMatchObject({ options: { nodeHost: null } });
    const node = parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--node-host', 'chi1.web-screen.net']);
    expect(node).toMatchObject({ command: 'run', options: { nodeHost: 'chi1.web-screen.net' } });
    for (const bad of ['https://chi1.web-screen.net', '-bad', 'attacker.example', 'localhost', '127.0.0.1', 'a.b.web-screen.net', 'web-screen.net', 'chi1.web-screen.net.evil.example']) {
      expect(() => parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--node-host', bad])).toThrow('web-screen.net');
    }
    expect(() => validateRunOptions({ minutes: 1, source: 'https://example.test', player: null, profileDir: '/tmp/profile', outDir: '/tmp/out', videoProfile: 'quality', maxBitrate: null, abCycleSeconds: null, scrollPixelsPerSecond: 0, outletQualitySeconds: 20, notifyDiscordChannelId: null, serverSnapHost: null, streamId: null, nodeHost: 'evil.example', readHost: null })).toThrow('web-screen.net');
    expect(parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--node-host', 'chi1.web-screen.net', '--read-host', 'chi1.web-screen.net:5554'])).toMatchObject({ options: { nodeHost: 'chi1.web-screen.net', readHost: 'chi1.web-screen.net:5554' } });
    expect(() => validateReadHost('chi1.web-screen.net')).not.toThrow();
    for (const bad of ['evil.example:554', 'chi1.web-screen.net:0', 'chi1.web-screen.net:70000', 'chi1.web-screen.net:5554:1', '88.216.73.71:554']) {
      expect(() => validateReadHost(bad)).toThrow();
    }
    expect(parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--video-profile', 'realtime', '--max-bitrate', '1500000', '--scroll', '240'])).toMatchObject({ command: 'run', options: { videoProfile: 'realtime', maxBitrate: 1_500_000, scrollPixelsPerSecond: 240 } });
    expect(parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--ab-cycle', '60', '--max-bitrate', '1500000'])).toMatchObject({ command: 'run', options: { videoProfile: 'quality', abCycleSeconds: 60, maxBitrate: 1_500_000 } });
    expect(parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--stream-id', 'Ab12Cd34Ef56'])).toMatchObject({ command: 'run', options: { streamId: 'Ab12Cd34Ef56' } });
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
    expect(() => parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--ab-cycle', '105', '--max-bitrate', '1500000'])).toThrow('must exceed');
    expect(() => parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--stream-id', 'invalid-id'])).toThrow('12-character alphanumeric');
    expect(parseLatencyProbeArgs(['run', '--minutes', '2', '--source', 'https://example.test', '--ab-cycle', '104', '--max-bitrate', '1500000'])).toMatchObject({ command: 'run', options: { abCycleSeconds: 104 } });
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
    const quality = new URL(screenShareUrl({ videoProfile: 'quality', maxBitrate: null, streamId: null }));
    expect(quality.search).toBe('');
    const realtime = new URL(screenShareUrl({ videoProfile: 'realtime', maxBitrate: 1_500_000, streamId: null }));
    expect([...realtime.searchParams.entries()]).toEqual([
      ['video-profile', 'realtime'], ['video-max-bitrate', '1500000'],
    ]);
  });

  test('固定 ID がある時は共有ページ URL の stream-id query に渡す', () => {
    const url = new URL(screenShareUrl({
      videoProfile: 'quality', maxBitrate: null, streamId: 'Ab12Cd34Ef56',
    }));
    expect([...url.searchParams.entries()]).toEqual([['stream-id', 'Ab12Cd34Ef56']]);
  });
});

describe('latency probe node host routing', () => {
  test('whipUrl のホストだけを差し替え、パスと https と他フィールドは保つ', () => {
    const body = JSON.stringify({ id: 'AbCdEf123456', whipUrl: 'https://webscreen.tv/live/AbCdEf123456/whip', streamUrl: 'rtspt://webscreen.tv/live/AbCdEf123456', status: 'live' });
    const rewritten = JSON.parse(rewriteWhipUrlHost(body, 'chi1.web-screen.net')) as Record<string, unknown>;
    expect(rewritten.whipUrl).toBe('https://chi1.web-screen.net/live/AbCdEf123456/whip');
    expect(rewritten.streamUrl).toBe('rtspt://webscreen.tv/live/AbCdEf123456');
    expect(rewritten.status).toBe('live');
  });

  test('合成 health は呼ばれるごとに egress が増える ready を返す', () => {
    const first = JSON.parse(syntheticHealthBody(0)) as { state: string; egressBytes: number };
    const second = JSON.parse(syntheticHealthBody(1)) as { state: string; egressBytes: number };
    expect(first.state).toBe('ready');
    expect(second.egressBytes).toBeGreaterThan(first.egressBytes);
  });

  test('書き換え応答のヘッダーから圧縮・長さ・validator を落とす', () => {
    const headers = headersForRewrittenBody({ 'Content-Type': 'application/json', 'Content-Encoding': 'br', 'content-length': '123', etag: 'W/"x"', 'cache-control': 'no-store' });
    expect(headers).toEqual({ 'Content-Type': 'application/json', 'cache-control': 'no-store' });
  });

  test('whipUrl を持たない応答と JSON でない本文はそのまま返す', () => {
    const error = JSON.stringify({ errorCode: 'streamLimitReached' });
    expect(rewriteWhipUrlHost(error, 'chi1.web-screen.net')).toBe(error);
    expect(rewriteWhipUrlHost('not json', 'chi1.web-screen.net')).toBe('not json');
    expect(rewriteWhipUrlHost('[1,2]', 'chi1.web-screen.net')).toBe('[1,2]');
  });
});

describe('latency probe windows recording deadline', () => {
  test('実時間の 1.5 倍 + 30 秒を待つ（VRChat 起動中の低速エンコードを吸収する）', () => {
    expect(recordingDeadlineSeconds(10)).toBe(45);
    expect(recordingDeadlineSeconds(480)).toBe(750);
    expect(recordingDeadlineSeconds(8)).toBe(42);
  });
});

/** 通知コマンドを起こさずに argv と stdin だけを記録する差し替え先。 */
function recordingSpawn(exitCode: number): { calls: { argv: string[]; stdin: string }[]; spawn: (argv: readonly string[], stdin: Uint8Array) => NotifyChild } {
  const calls: { argv: string[]; stdin: string }[] = [];
  return {
    calls,
    spawn: (argv, stdin) => {
      calls.push({ argv: [...argv], stdin: new TextDecoder().decode(stdin) });
      return {
        exited: Promise.resolve(exitCode),
        stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('boom')); controller.close(); } }),
        kill: () => undefined,
      };
    },
  };
}

describe('latency probe notify command', () => {
  test('空白区切りの argv を引用符つきで分解する', () => {
    expect(parseCommandLine('bun notify.ts --target nori')).toEqual(['bun', 'notify.ts', '--target', 'nori']);
    expect(parseCommandLine('  bun   notify.ts  ')).toEqual(['bun', 'notify.ts']);
    expect(parseCommandLine(`cmd --message '配信を開始しました: {url}'`)).toEqual(['cmd', '--message', '配信を開始しました: {url}']);
    expect(parseCommandLine('cmd --message "a b" --flag')).toEqual(['cmd', '--message', 'a b', '--flag']);
    // 語の途中の引用符（--message='a b' 形式）と、引用符内の別種の引用符
    expect(parseCommandLine(`cmd --message='a b' -x`)).toEqual(['cmd', '--message=a b', '-x']);
    expect(parseCommandLine(`cmd "it's here"`)).toEqual(['cmd', "it's here"]);
    // 空文字の引数は明示的に残す
    expect(parseCommandLine(`cmd "" tail`)).toEqual(['cmd', '', 'tail']);
  });

  test('閉じていない引用符とコマンド名なしは env の読み込み時点で失敗する', () => {
    expect(() => parseCommandLine(`cmd --message 'unterminated`)).toThrow(NOTIFY_COMMAND_ENV);
    expect(() => notifyCommandTemplate(`cmd "unterminated`)).toThrow(NOTIFY_COMMAND_ENV);
    expect(() => notifyCommandTemplate('"" --flag')).toThrow(NOTIFY_COMMAND_ENV);
  });

  test('未設定・空白のみの環境変数は null を返す', () => {
    expect(notifyCommandTemplate(undefined)).toBeNull();
    expect(notifyCommandTemplate('   ')).toBeNull();
  });

  test('{url} と {channel} を引数配列と stdin JSON へ反映する', async () => {
    const template = notifyCommandTemplate(`bun /opt/notify.ts --message '配信: {url}' --channel-id {channel} --url={url}`);
    expect(template).not.toBeNull();
    expect(buildNotifyArgv(template ?? [], { url: 'rtspt://chi1.web-screen.net/live/AbCdEf123456', channel: '123456789012345678' })).toEqual([
      'bun', '/opt/notify.ts', '--message', '配信: rtspt://chi1.web-screen.net/live/AbCdEf123456',
      '--channel-id', '123456789012345678', '--url=rtspt://chi1.web-screen.net/live/AbCdEf123456',
    ]);
    const recorder = recordingSpawn(0);
    const info = spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await notifyStreamUrl({ template: template ?? [], url: 'rtspt://host/live/AbCdEf123456', channel: '123456789012345678', timeoutMs: 200, spawn: recorder.spawn });
    } finally { info.mockRestore(); }
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.argv).toContain('配信: rtspt://host/live/AbCdEf123456');
    expect(recorder.calls[0]?.argv).toContain('123456789012345678');
    expect(JSON.parse(recorder.calls[0]?.stdin ?? '{}')).toEqual({ url: 'rtspt://host/live/AbCdEf123456', channel: '123456789012345678' });
    expect(notifyStdinJson({ url: 'u', channel: 'c' }).endsWith('\n')).toBe(true);
  });

  test('未設定なら警告だけ出して例外にせず計測を続行する', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      warnNotifyCommandMissing();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(NOTIFY_COMMAND_ENV);
    } finally { warn.mockRestore(); }
  });

  test('非ゼロ終了は警告に落として run を止めない', async () => {
    const recorder = recordingSpawn(3);
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await notifyStreamUrl({ template: ['notify'], url: 'rtspt://host/live/AbCdEf123456', channel: '123456789012345678', timeoutMs: 200, spawn: recorder.spawn });
      expect(String(warn.mock.calls[0]?.[0])).toContain('boom');
    } finally { warn.mockRestore(); }
  });

  test('既定の spawn で実プロセスを起こし、成功を info で報告する', async () => {
    const info = spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await notifyStreamUrl({ template: ['echo', '{channel}', '{url}'], url: 'rtspt://host/live/AbCdEf123456', channel: '123456789012345678', timeoutMs: 5_000 });
      expect(String(info.mock.calls[0]?.[0])).toContain('123456789012345678');
    } finally { info.mockRestore(); }
  });

  test('固まったコマンドはタイムアウトで kill して警告に落とす', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const startedAt = Date.now();
    try {
      // stderr を先に await していると pipe が閉じずタイムアウトが始まらない（実プロセスでの回帰確認）
      await notifyStreamUrl({ template: ['sleep', '30'], url: 'rtspt://host/live/AbCdEf123456', channel: '123456789012345678', timeoutMs: 200 });
      expect(String(warn.mock.calls[0]?.[0])).toContain('exit -1');
    } finally { warn.mockRestore(); }
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test('存在しないコマンドでも spawn の同期例外を警告に落として run を止めない', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Bun.spawn は実行ファイルが無いと同期で ENOENT を投げる（実プロセスでの回帰確認）
      await notifyStreamUrl({ template: ['/nonexistent/webscreen-notify-xyz', '{channel}'], url: 'rtspt://host/live/AbCdEf123456', channel: '123456789012345678', timeoutMs: 200 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('/nonexistent/webscreen-notify-xyz');
      expect(String(warn.mock.calls[0]?.[0])).toContain('起動できませんでした');
    } finally { warn.mockRestore(); }
  });

  test('SIGTERM を無視する子も期限内に打ち切り、SIGKILL まで上げて残さない', async () => {
    const exits: Promise<number>[] = [];
    const spawn: NotifySpawn = (argv, stdin) => {
      const child = Bun.spawn([...argv], { stdin, stdout: 'ignore', stderr: 'pipe' });
      exits.push(child.exited);
      return { exited: child.exited, stderr: requirePipe(child.stderr, 'test notify stderr'), kill: (signal) => child.kill(signal) };
    };
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    const startedAt = Date.now();
    try {
      await notifyStreamUrl({
        template: [process.execPath, '-e', "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30_000)"],
        url: 'rtspt://host/live/AbCdEf123456', channel: '123456789012345678', timeoutMs: 300, spawn,
      });
      expect(String(warn.mock.calls[0]?.[0])).toContain('exit -1');
    } finally { warn.mockRestore(); }
    // 期限 + kill 猶予 + stderr 猶予の合計で返ること（stderr の EOF 待ちで 30 秒引きずらない）
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    // 30 秒の孤児を残さない（SIGTERM だけでは死なないので SIGKILL まで上げられているか）
    expect(await Promise.race([exits[0] ?? Promise.resolve(0), Bun.sleep(1_000).then(() => 'alive')])).not.toBe('alive');
  });

  test('stderr は上限で切り詰めて警告に載せる', async () => {
    const noisy: NotifySpawn = () => ({
      exited: Promise.resolve(1),
      stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('e'.repeat(10_000))); controller.close(); } }),
      kill: () => undefined,
    });
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await notifyStreamUrl({ template: ['notify'], url: 'rtspt://host/live/AbCdEf123456', channel: '123456789012345678', timeoutMs: 200, spawn: noisy });
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message.match(/e{2,}/)?.[0]).toHaveLength(4_096);
      expect(message).toContain(NOTIFY_STDERR_TRUNCATED_SUFFIX);
    } finally { warn.mockRestore(); }
  });

  // docs の注入例と同じ形（$HOME 展開後の絶対パス + 引用符つきメッセージ）が argv へ落ちることを確認する。
  // 実パスは書かない（リポジトリに個人環境の固定パスを残さないのが本変更の目的）。
  test('docs の通知コマンド例が argv へ分解できる', () => {
    const template = notifyCommandTemplate(`bun /Users/example/notify-discord.ts --message '遅延計測の配信を開始しました。VRChat に貼ってください: {url}' --target nori --channel-id {channel} --project-dir .`);
    expect(template?.[0]).toBe('bun');
    expect(template).toContain('遅延計測の配信を開始しました。VRChat に貼ってください: {url}');
    expect(template?.slice(-4)).toEqual(['--channel-id', '{channel}', '--project-dir', '.']);
  });
});
