/** 遅延計測用ブロックコードの固定辺長。 */
export const BLOCK_GRID_SIZE = 16;
const PAYLOAD_BITS = 56;
const RESERVED = new Set(['1,1', '14,1', '1,14', '14,14']);

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
  if (rgb.length !== width * height * 3 || width < BLOCK_GRID_SIZE || height < BLOCK_GRID_SIZE) return null;
  const maxCell = Math.floor(Math.min(width, height) / BLOCK_GRID_SIZE);
  // 格子の辺を半セル刻みで走査し、見つかった候補だけを詳細復号する。
  for (let cell = 8; cell <= maxCell; cell += 2) {
    const stride = Math.max(2, Math.floor(cell / 2));
    for (let y = 0; y + cell * BLOCK_GRID_SIZE <= height; y += stride) {
      for (let x = 0; x + cell * BLOCK_GRID_SIZE <= width; x += stride) {
        if (!matchesSyncSamples(rgb, width, x, y, cell)) continue;
        const grid = sampleGrid(rgb, width, x, y, cell);
        const timestamp = decodeBlockCode(grid);
        if (timestamp !== null) return timestamp;
      }
    }
  }
  return null;
}

/** PCMから1 kHzビープの立ち上がりsample indexを検出する。 */
export function detectBeepOnsets(samples: Float32Array, sampleRate: number): number[] {
  const window = Math.max(32, Math.round(sampleRate * 0.02));
  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  const onsets: number[] = [];
  let active = false;
  for (let start = 0; start + window <= samples.length; start += hop) {
    const level = goertzelPower(samples, start, window, sampleRate, 1_000);
    const isTone = level > 0.008;
    if (isTone && !active) onsets.push(start);
    active = isTone;
  }
  return onsets;
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

function goertzelPower(samples: Float32Array, start: number, length: number, sampleRate: number, frequency: number): number {
  const coefficient = 2 * Math.cos((2 * Math.PI * frequency) / sampleRate);
  let previous = 0;
  let previousPrevious = 0;
  for (let index = start; index < start + length; index += 1) {
    const current = samples[index]! + coefficient * previous - previousPrevious;
    previousPrevious = previous;
    previous = current;
  }
  return (previous * previous + previousPrevious * previousPrevious - coefficient * previous * previousPrevious) / (length * length);
}
