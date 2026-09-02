import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeBlockCodeFrameWithReason } from './latency-probe-codec';
import { readPipeText, requirePipe } from './latency-probe-observe';

/** relay の手前（ingress 8554）と後（egress 554）を並列起動で撮り、遅延がどこで生じているかを分ける。 */
export interface ServerSnapshotRow { round: number; hop: 'ingress' | 'egress'; beforeMs: number; afterMs: number; frameMs: number | null; reason: string | null; }
const HOPS: ReadonlyArray<{ hop: 'ingress' | 'egress'; port: number }> = [{ hop: 'ingress', port: 8554 }, { hop: 'egress', port: 554 }];
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];
const MAX_PNG_BYTES = 20 * 1024 * 1024;

/** 計測終了20秒前までに収まる、計測時間比例のサーバー内取得時刻を返す。 */
export function snapshotScheduleSeconds(minutes: number): number[] {
  const duration = minutes * 60;
  return [0.15, 0.5, 0.85].map((ratio) => Math.floor(Math.min(duration * ratio, duration - 20))).filter((second, index, all) => second >= 0 && all.indexOf(second) === index);
}

/** run 中に指定秒でサーバー内スナップショットを撮り、復号結果を server-snap.md へ残す。 */
export async function captureServerSnapshots(host: string, streamId: string, outDir: string, startedAtMs: number, roundsAtSeconds: readonly number[]): Promise<ServerSnapshotRow[]> {
  if (!isValidHost(host) || !/^[A-Za-z0-9]{12}$/.test(streamId)) throw new Error('server snapshot host / stream id が不正です');
  const localDir = join(outDir, 'server-snap'); await mkdir(localDir, { recursive: true, mode: 0o700 });
  const rows: ServerSnapshotRow[] = []; const warnings: string[] = [];
  try {
    for (const [index, seconds] of roundsAtSeconds.entries()) {
      const target = startedAtMs + seconds * 1_000;
      if (target >= startedAtMs && target + 20_000 <= startedAtMs + Math.max(...roundsAtSeconds, 0) * 1_000 + 20_000) await Bun.sleep(Math.max(0, target - Date.now()));
      const remote = await startRemoteRound(host, streamId, index);
      warnings.push(...remote.warnings);
      for (const line of remote.lines) {
        const [hop, before, after, exit] = line.trim().split(/\s+/);
        if ((hop !== 'ingress' && hop !== 'egress') || !before || !after) continue;
        const local = join(localDir, `${hop}-${index}.png`);
        try {
          await runText(['scp', '-q', ...SSH_OPTIONS, '--', `${host}:${remote.directory}/${hop}-${index}.png`, local], 20_000);
          const decoded = await decodePng(local);
          rows.push({ round: index, hop, beforeMs: Number(before), afterMs: Number(after), frameMs: decoded.timestampMs, reason: Number(exit) === 0 ? decoded.reason : `ffmpeg exit=${exit}` });
        } catch (error) { warnings.push(`${hop}-${index}: ${String(error)}`); rows.push({ round: index, hop, beforeMs: Number(before), afterMs: Number(after), frameMs: null, reason: 'PNG回収または復号失敗' }); }
      }
      await remote.finished;
    }
  } finally { await writeFile(join(outDir, 'server-snap.md'), formatServerSnapshots(rows, warnings), { mode: 0o600 }); }
  return rows;
}

/** SSH 用ホスト名をlabel単位で検証する。 */
export function isValidHost(host: string): boolean { return host.length <= 253 && host.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)); }

async function startRemoteRound(host: string, streamId: string, round: number): Promise<{ directory: string; lines: string[]; warnings: string[]; finished: Promise<void> }> {
  const script = `umask 077; d=$(mktemp -d /tmp/latency-snap.XXXXXX) || exit 1; trap 'rm -rf "$d"' EXIT; echo "$d"; capture(){ n="$1"; p="$2"; b=$(date -u +%s%3N); timeout 15 ffmpeg -v error -y -rtsp_transport tcp -fflags nobuffer -flags low_delay -i "rtsp://127.0.0.1:$p/live/${streamId}" -frames:v 1 -pix_fmt rgb24 "$d/$n-${round}.png"; c=$?; a=$(date -u +%s%3N); echo "$n $b $a $c" >> "$d/results"; }; capture ingress 8554 & capture egress 554 & wait; cat "$d/results"; echo READY; sleep 12`;
  const child = Bun.spawn(['ssh', ...SSH_OPTIONS, '--', host, script], { stdout: 'pipe', stderr: 'pipe' });
  const reader = requirePipe(child.stdout, 'server snapshot stdout').getReader(); const decoder = new TextDecoder(); let pending = ''; const lines: string[] = []; let directory: string | null = null;
  while (directory === null || !lines.includes('READY')) {
    const next = await readWithDeadline(reader.read(), 30_000, child);
    if (next.done) throw new Error('server snapshot closed before READY');
    pending += decoder.decode(next.value, { stream: true });
    const complete = pending.split(/\r?\n/); pending = complete.pop() ?? '';
    for (const line of complete) { if (directory === null) directory = line; else lines.push(line); }
  }
  const stderr = readPipeText(requirePipe(child.stderr, 'server snapshot stderr'));
  const finished = Promise.all([child.exited, stderr]).then(([exit, error]) => { if (exit !== 0) throw new Error(`server snapshot ssh failed: ${error.trim()}`); });
  return { directory: directory!, lines: lines.filter((line) => line !== 'READY'), warnings: [], finished };
}

/** サーバー内スナップショットの表。before/after はサーバー壁時計（ffmpeg 起動直前・終了直後）。 */
export function formatServerSnapshots(rows: readonly ServerSnapshotRow[], warnings: readonly string[] = []): string {
  const lines = ['# サーバー内スナップショット（relay 前後）', '', '| round | hop | before−frame ms | after−frame ms | frame (epoch ms) | 備考 |', '|---:|---|---:|---:|---:|---|'];
  for (const row of rows) lines.push(`| ${row.round} | ${row.hop} | ${row.frameMs === null ? '' : String(row.beforeMs - row.frameMs)} | ${row.frameMs === null ? '' : String(row.afterMs - row.frameMs)} | ${row.frameMs ?? ''} | ${row.reason ?? ''} |`);
  if (warnings.length) lines.push('', '## 警告', '', ...warnings.map((warning) => `- ${warning}`));
  lines.push('', 'フレームは before〜after の間に取得される。ingress と egress は並列起動であり、差は relay の遅延を示す近似値である。'); return `${lines.join('\n')}\n`;
}

async function decodePng(path: string): Promise<{ timestampMs: number | null; reason: string | null }> {
  const bytes = new Uint8Array(await readFile(path));
  if (bytes.length > MAX_PNG_BYTES || bytes.length < 24 || bytes.slice(0, 8).join(',') !== '137,80,78,71,13,10,26,10') throw new Error('PNG署名またはサイズが不正です');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const width = view.getUint32(16); const height = view.getUint32(20);
  if (width === 0 || height === 0 || width > 4096 || height > 4096) throw new Error('PNG寸法が上限を超えています');
  const child = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', path, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { stdout: 'pipe', stderr: 'pipe' });
  const rgb = new Uint8Array(await new Response(requirePipe(child.stdout, 'png rawvideo')).arrayBuffer()); if (await child.exited !== 0) throw new Error('PNG復号に失敗しました');
  const decoded = decodeBlockCodeFrameWithReason(rgb, width, height); return { timestampMs: decoded.timestampMs, reason: decoded.reason };
}
async function runText(command: string[], timeoutMs: number): Promise<string> { const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' }); const [stdout, stderr] = await Promise.all([readPipeText(requirePipe(child.stdout, 'stdout')), readPipeText(requirePipe(child.stderr, 'stderr'))]); const exit = await waitFor(child, timeoutMs); if (exit !== 0) throw new Error(`${command[0]} failed: ${stderr.trim()}`); return stdout; }
async function readWithDeadline<T>(promise: Promise<T>, timeoutMs: number, child: Bun.Subprocess): Promise<T> { return new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(new Error('server snapshot timeout')); }, timeoutMs); promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); }); }); }
async function waitFor(child: Bun.Subprocess, timeoutMs: number): Promise<number> { const timeout = setTimeout(() => child.kill(), timeoutMs); const result = await child.exited; clearTimeout(timeout); return result; }
