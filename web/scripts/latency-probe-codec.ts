/** 遅延計測用ブロックコードの固定辺長。 */
export const BLOCK_GRID_SIZE = 16;
const PAYLOAD_BITS = 56;
const RESERVED = new Set(['1,1', '14,1', '1,14', '14,14']);

/** フレームの復号結果と、失敗時に記録する診断理由。 */
export interface BlockCodeFrameDecodeResult {
  timestampMs: number | null;
  reason: 'sync-pattern-not-found' | 'checksum-mismatch' | null;
}

/** ミリ秒時刻を48 bit + checksumへ符号化した白黒セル格子を返す。 */
export function encodeBlockCode(timestampMs: number): boolean[][] {
  if (!Number.isSafeInteger(timestampMs) || timestampMs < 0 || timestampMs >= 2 ** 48) {
    throw new Error('timestampMs must be an unsigned 48 bit integer');
  }
  const grid = Array.from({ length: BLOCK_GRID_SIZE }, () => Array<boolean>(BLOCK_GRID_SIZE).fill(false));
  for (let index = 0; index < BLOCK_GRID_SIZE; index += 1) {
    grid[0]![index] = index % 2 === 0;
    grid[BLOCK_GRID_SIZE - 1]![index] = index % 2 !== 0;
  }
  for (let index = 1; index < BLOCK_GRID_SIZE - 1; index += 1) {
    grid[index]![0] = index % 3 !== 0;
    grid[index]![BLOCK_GRID_SIZE - 1] = index % 3 === 0;
  }
  const value = (BigInt(timestampMs) << 8n) | BigInt(timestampChecksum(timestampMs));
  let bit = 0;
  for (let y = 1; y < BLOCK_GRID_SIZE - 1 && bit < PAYLOAD_BITS; y += 1) {
    for (let x = 1; x < BLOCK_GRID_SIZE - 1 && bit < PAYLOAD_BITS; x += 1) {
      if (RESERVED.has(`${x},${y}`)) continue;
      grid[y]![x] = (value & (1n << BigInt(PAYLOAD_BITS - 1 - bit))) !== 0n;
      bit += 1;
    }
  }
  return grid;
}

/** 格子からchecksumを検査したミリ秒時刻を復号する。 */
export function decodeBlockCode(grid: readonly (readonly boolean[])[]): number | null {
  if (grid.length !== BLOCK_GRID_SIZE || grid.some((row) => row.length !== BLOCK_GRID_SIZE)) return null;
  if (!hasSyncPattern(grid)) return null;
  let value = 0n;
  let bit = 0;
  for (let y = 1; y < BLOCK_GRID_SIZE - 1 && bit < PAYLOAD_BITS; y += 1) {
    for (let x = 1; x < BLOCK_GRID_SIZE - 1 && bit < PAYLOAD_BITS; x += 1) {
      if (RESERVED.has(`${x},${y}`)) continue;
      value = (value << 1n) | (grid[y]![x] ? 1n : 0n);
      bit += 1;
    }
  }
  const timestampMs = Number(value >> 8n);
  return Number(value & 0xffn) === timestampChecksum(timestampMs) ? timestampMs : null;
}

/** RGB24フレームから同期枠を探索し、最初に検証できた時刻を返す。 */
export function decodeBlockCodeFrame(
  rgb: Uint8Array, width: number, height: number
): number | null {
  return decodeBlockCodeFrameWithReason(rgb, width, height).timestampMs;
}

/** RGB24フレームを復号し、失敗原因を診断用に返す。 */
export function decodeBlockCodeFrameWithReason(
  rgb: Uint8Array, width: number, height: number
): BlockCodeFrameDecodeResult {
  if (rgb.length !== width * height * 3 || width < BLOCK_GRID_SIZE || height < BLOCK_GRID_SIZE) {
    return { timestampMs: null, reason: 'sync-pattern-not-found' };
  }
  const maxCell = Math.floor(Math.min(width, height) / BLOCK_GRID_SIZE);
  let foundSyncPattern = false;
  // 格子の辺を半セル刻みで走査し、見つかった候補だけを詳細復号する。
  for (let cell = 8; cell <= maxCell; cell += 2) {
    const stride = Math.max(2, Math.floor(cell / 2));
    for (let y = 0; y + cell * BLOCK_GRID_SIZE <= height; y += stride) {
      for (let x = 0; x + cell * BLOCK_GRID_SIZE <= width; x += stride) {
        if (!matchesSyncSamples(rgb, width, x, y, cell)) continue;
        foundSyncPattern = true;
        const grid = sampleGrid(rgb, width, x, y, cell);
        const timestamp = decodeBlockCode(grid);
        if (timestamp !== null) return { timestampMs: timestamp, reason: null };
      }
    }
  }
  return { timestampMs: null, reason: foundSyncPattern ? 'checksum-mismatch' : 'sync-pattern-not-found' };
}

/** 1 kHz近傍だけを通す二次バンドパスフィルタを適用する。 */
export function bandPassOneKilohertz(samples: Float32Array, sampleRate: number): Float32Array {
  if (!Number.isFinite(sampleRate) || sampleRate < 4_000) throw new Error('sampleRate must be at least 4000');
  const centerHz = 1_000;
  const quality = 5;
  const omega = (2 * Math.PI * centerHz) / sampleRate;
  const alpha = Math.sin(omega) / (2 * quality);
  const a0 = 1 + alpha;
  const b0 = alpha / a0;
  const b2 = -b0;
  const a1 = (-2 * Math.cos(omega)) / a0;
  const a2 = (1 - alpha) / a0;
  const filtered = new Float32Array(samples.length);
  let input1 = samples[0] ?? 0;
  let input2 = samples[0] ?? 0;
  let output1 = 0;
  let output2 = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const output = b0 * samples[index]! + b2 * input2 - a1 * output1 - a2 * output2;
    filtered[index] = output;
    input2 = input1;
    input1 = samples[index]!;
    output2 = output1;
    output1 = output;
  }
  return filtered;
}

/** PCMからノイズフロア基準で1 kHzビープの立ち上がりsample indexを検出する。 */
export function detectBeepOnsets(samples: Float32Array, sampleRate: number): number[] {
  const window = Math.max(32, Math.round(sampleRate * 0.02));
  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  const filtered = bandPassOneKilohertz(samples, sampleRate);
  const energies: Array<{ start: number; energy: number }> = [];
  for (let start = 0; start + window <= filtered.length; start += hop) {
    energies.push({ start, energy: meanSquare(filtered, start, window) });
  }
  if (energies.length === 0) return [];
  const sorted = energies.map((item) => item.energy).sort((left, right) => left - right);
  const noiseFloor = sorted[Math.floor((sorted.length - 1) * 0.2)]!;
  const threshold = Math.max(noiseFloor * 8, noiseFloor + 0.000_001);
  const onsets: number[] = [];
  let active = false;
  for (const { start, energy } of energies) {
    const isTone = energy > threshold;
    // エネルギー窓の中央を立ち上がり時刻として扱い、窓の先読み分を補正する。
    if (isTone && !active) onsets.push(start + Math.floor(window / 2));
    active = isTone;
  }
  return onsets;
}

/** Float32モノラルPCMを標準の16 bit WAVへ変換する。 */
export function encodeMonoWav(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new Error('sampleRate must be a positive integer');
  const output = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(output.buffer);
  writeAscii(output, 0, 'RIFF');
  view.setUint32(4, output.length - 8, true);
  writeAscii(output, 8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(output, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]!));
    view.setInt16(44 + index * 2, Math.round(sample * 32_767), true);
  }
  return output;
}

/** 標準の16 bitモノラルWAVをビープ解析用PCMへ変換する。 */
export function decodeMonoWav(wav: Uint8Array): { samples: Float32Array; sampleRate: number } {
  if (wav.length < 44 || readAscii(wav, 0, 4) !== 'RIFF' || readAscii(wav, 8, 4) !== 'WAVE') {
    throw new Error('invalid WAV header');
  }
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  let offset = 12;
  let sampleRate: number | null = null;
  let dataOffset: number | null = null;
  let dataLength: number | null = null;
  while (offset + 8 <= wav.length) {
    const id = readAscii(wav, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + length > wav.length) throw new Error('truncated WAV chunk');
    if (id === 'fmt ') {
      if (length < 16 || view.getUint16(body, true) !== 1 || view.getUint16(body + 2, true) !== 1 || view.getUint16(body + 14, true) !== 16) {
        throw new Error('WAV must be 16 bit mono PCM');
      }
      sampleRate = view.getUint32(body + 4, true);
    }
    if (id === 'data') {
      dataOffset = body;
      dataLength = length;
      break;
    }
    offset = body + length + (length % 2);
  }
  if (!sampleRate || dataOffset === null || dataLength === null || dataLength % 2 !== 0) throw new Error('WAV data chunk is missing');
  const samples = new Float32Array(dataLength / 2);
  for (let index = 0; index < samples.length; index += 1) samples[index] = view.getInt16(dataOffset + index * 2, true) / 32_768;
  return { samples, sampleRate };
}

/** 端末時計の差を引き、Windowsで観測した時刻をMac時計へ揃える。 */
export function compensateClockOffset(observedMs: number, windowsMinusMacMs: number): number {
  return observedMs - windowsMinusMacMs;
}

function timestampChecksum(timestampMs: number): number {
  let value = BigInt(timestampMs);
  let checksum = 0xa7;
  for (let index = 0; index < 6; index += 1) {
    checksum ^= Number(value & 0xffn);
    checksum = ((checksum << 1) | (checksum >>> 7)) & 0xff;
    value >>= 8n;
  }
  return checksum;
}

function hasSyncPattern(grid: readonly (readonly boolean[])[]): boolean {
  for (let index = 0; index < BLOCK_GRID_SIZE; index += 1) {
    if (grid[0]![index] !== (index % 2 === 0)) return false;
    if (grid[BLOCK_GRID_SIZE - 1]![index] !== (index % 2 !== 0)) return false;
  }
  for (let index = 1; index < BLOCK_GRID_SIZE - 1; index += 1) {
    if (grid[index]![0] !== (index % 3 !== 0)) return false;
    if (grid[index]![BLOCK_GRID_SIZE - 1] !== (index % 3 === 0)) return false;
  }
  return true;
}

function matchesSyncSamples(rgb: Uint8Array, width: number, x: number, y: number, cell: number): boolean {
  const samples: Array<[number, number, boolean]> = [
    [0, 0, true], [1, 0, false], [2, 0, true], [0, 1, true], [0, 3, false],
    [15, 0, false], [15, 3, true], [0, 15, false], [1, 15, true], [15, 15, true],
  ];
  return samples.every(([gx, gy, expected]) => pixelIsWhite(rgb, width, x + (gx + 0.5) * cell, y + (gy + 0.5) * cell) === expected);
}

function sampleGrid(rgb: Uint8Array, width: number, x: number, y: number, cell: number): boolean[][] {
  return Array.from({ length: BLOCK_GRID_SIZE }, (_, gy) => Array.from(
    { length: BLOCK_GRID_SIZE },
    (_, gx) => pixelIsWhite(rgb, width, x + (gx + 0.5) * cell, y + (gy + 0.5) * cell)
  ));
}

function pixelIsWhite(rgb: Uint8Array, width: number, x: number, y: number): boolean {
  const offset = (Math.floor(y) * width + Math.floor(x)) * 3;
  return (rgb[offset]! + rgb[offset + 1]! + rgb[offset + 2]!) / 3 >= 128;
}

function meanSquare(samples: Float32Array, start: number, length: number): number {
  let total = 0;
  for (let index = start; index < start + length; index += 1) total += samples[index]! ** 2;
  return total / length;
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) target[offset + index] = value.charCodeAt(index);
}

function readAscii(source: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...source.slice(offset, offset + length));
}
