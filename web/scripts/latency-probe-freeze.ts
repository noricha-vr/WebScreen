/** freezedetectログから窓内のfreeze回数と継続秒数を集計する。 */
export function parseFreezeLog(log: string, windowSeconds: number): { freezes: number; freezeSeconds: number } {
  const windowEnd = Math.max(0, windowSeconds);
  let freezeStart: number | null = null;
  let freezes = 0;
  let freezeSeconds = 0;
  for (const match of log.matchAll(/lavfi\.freezedetect\.(freeze_start|freeze_end):\s*([0-9.]+)/g)) {
    const timestamp = Number(match[2]);
    if (!Number.isFinite(timestamp)) continue;
    if (match[1] === 'freeze_start') {
      freezeStart = timestamp;
      continue;
    }
    if (freezeStart === null) continue;
    const start = Math.max(0, Math.min(windowEnd, freezeStart));
    const end = Math.max(start, Math.min(windowEnd, timestamp));
    if (start < windowEnd) { freezes += 1; freezeSeconds += end - start; }
    freezeStart = null;
  }
  // freezedetectは窓の終端でfreeze_endを出さないため、未閉鎖分を実測窓末尾まで含める。
  if (freezeStart !== null) {
    const start = Math.max(0, Math.min(windowEnd, freezeStart));
    if (start < windowEnd) { freezes += 1; freezeSeconds += windowEnd - start; }
  }
  return { freezes, freezeSeconds };
}
