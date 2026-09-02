import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeBlockCodeFrameWithReason } from './latency-probe-codec';
import { readPipeText, requirePipe } from './latency-probe-observe';

/** relay の手前（ingress 8554）と後（egress 554）を同時刻に撮り、遅延がどこで生じているかを分ける。 */
export interface ServerSnapshotRow {
  round: number; hop: 'ingress' | 'egress'; beforeMs: number; afterMs: number; frameMs: number | null; reason: string | null;
}

const HOPS: ReadonlyArray<{ hop: 'ingress' | 'egress'; port: number }> = [{ hop: 'ingress', port: 8554 }, { hop: 'egress', port: 554 }];

/** run 中に指定秒でサーバー内スナップショットを撮り、復号結果を server-snap.md へ残す。失敗は run を止めない。 */
export async function captureServerSnapshots(host: string, streamId: string, outDir: string, startedAtMs: number, roundsAtSeconds: readonly number[]): Promise<ServerSnapshotRow[]> {
  if (!/^[A-Za-z0-9.-]+$/.test(host) || !/^[A-Za-z0-9]{12}$/.test(streamId)) throw new Error('server snapshot host / stream id が不正です');
  const localDir = join(outDir, 'server-snap');
  await mkdir(localDir, { recursive: true });
  const remoteDir = `/tmp/latency-snap-${streamId}`;
  const rows: ServerSnapshotRow[] = [];
  try {
    for (const [index, seconds] of roundsAtSeconds.entries()) {
      const waitMs = startedAtMs + seconds * 1_000 - Date.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const script = `mkdir -p ${remoteDir}; for src in ingress:8554 egress:554; do n=\${src%%:*}; port=\${src##*:}; b=$(date -u +%s%3N); ffmpeg -v error -y -rtsp_transport tcp -fflags nobuffer -flags low_delay -i rtsp://127.0.0.1:$port/live/${streamId} -frames:v 1 -pix_fmt rgb24 ${remoteDir}/$n-${index}.png; a=$(date -u +%s%3N); echo "$n $b $a"; done`;
      const stdout = await runText(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, script]);
      for (const line of stdout.trim().split('\n')) {
        const [hop, before, after] = line.trim().split(/\s+/);
        if ((hop !== 'ingress' && hop !== 'egress') || !before || !after) continue;
        const local = join(localDir, `${hop}-${index}.png`);
        await runText(['scp', '-q', '-o', 'BatchMode=yes', `${host}:${remoteDir}/${hop}-${index}.png`, local]);
        const decoded = await decodePng(local);
        rows.push({ round: index, hop, beforeMs: Number(before), afterMs: Number(after), frameMs: decoded.timestampMs, reason: decoded.reason });
      }
    }
  } finally {
    await runText(['ssh', '-o', 'BatchMode=yes', host, `rm -rf ${remoteDir}`]).catch(() => undefined);
    await writeFile(join(outDir, 'server-snap.md'), formatServerSnapshots(rows));
  }
  return rows;
}

/** サーバー内スナップショットの表。before/after はサーバー壁時計（ffmpeg 起動直前・終了直後）。 */
export function formatServerSnapshots(rows: readonly ServerSnapshotRow[]): string {
  const lines = ['# サーバー内スナップショット（relay 前後）', '', '| round | hop | before−frame ms | after−frame ms | frame (epoch ms) | 備考 |', '|---:|---|---:|---:|---:|---|'];
  for (const row of rows) {
    const before = row.frameMs === null ? '' : String(row.beforeMs - row.frameMs);
    const after = row.frameMs === null ? '' : String(row.afterMs - row.frameMs);
    lines.push(`| ${row.round} | ${row.hop} | ${before} | ${after} | ${row.frameMs ?? ''} | ${row.reason ?? ''} |`);
  }
  lines.push('', 'フレームは before〜after の間に取得されている。ingress と egress の差が relay の遅延、ingress の値が「配信元 → ingress」の遅延（サーバー時計基準）。');
  return `${lines.join('\n')}\n`;
}

async function decodePng(path: string): Promise<{ timestampMs: number | null; reason: string | null }> {
  const dims = (await runText(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path])).trim().split(',').map(Number);
  const [width, height] = dims;
  if (!width || !height) return { timestampMs: null, reason: 'png-dimensions' };
  const child = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', path, '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { stdout: 'pipe', stderr: 'pipe' });
  const rgb = new Uint8Array(await new Response(requirePipe(child.stdout, 'png rawvideo')).arrayBuffer());
  await child.exited;
  const decoded = decodeBlockCodeFrameWithReason(rgb, width, height);
  return { timestampMs: decoded.timestampMs, reason: decoded.reason };
}

async function runText(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([readPipeText(requirePipe(child.stdout, 'stdout')), readPipeText(requirePipe(child.stderr, 'stderr'))]);
  if (await child.exited !== 0) throw new Error(`${command[0]} failed: ${stderr.trim()}`);
  return stdout;
}
