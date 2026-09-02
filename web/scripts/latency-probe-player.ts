import { chmod, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { LatencySample } from './latency-probe-analysis';
import { compensateClockOffset, decodeBlockCodeFrame } from './latency-probe-codec';
import { probeDimensionsFor, readPipeText, requirePipe } from './latency-probe-observe';

/** Windows側計測の保存結果と診断情報。 */
export interface PlayerResult { samples: LatencySample[]; warning: string | null; diagnostics: string }

const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];
const MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024;

/** 対話WindowsセッションのScheduled Taskで録画し、復号標本を返す。 */
export async function recordWindowsPlayer(outDir: string, until: number): Promise<PlayerResult> {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1_000));
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const remoteDir = `$env:TEMP\\webscreen-latency-${runId}`;
  const remote = `${remoteDir}\\recording.mp4`;
  const log = `${remoteDir}\\ffmpeg.log`;
  const started = `${remoteDir}\\started.txt`;
  const done = `${remoteDir}\\done.txt`;
  const ffmpeg = 'C:\\Users\\win\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-7.1.1-full_build\\bin\\ffmpeg.exe';
  let diagnostics = '';
  try {
    const command = `$ErrorActionPreference='Stop'; $ff='${ffmpeg}'; $root=${remoteDir}; $out='${remote}'; $log='${log}'; $startedPath='${started}'; $donePath='${done}'; $task='WebScreenLatencyHarness'; Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Path $root -Force | Out-Null; $taskScript="\`$recorded=[DateTime]::UtcNow; Set-Content -LiteralPath '$started' -Value \`$recorded.ToString('o') -NoNewline; & '$ff' -y -f gdigrab -framerate 30 -i desktop -t ${seconds} '$remote' 2>&1 | Set-Content -LiteralPath '$log'; \`$code=\`$LASTEXITCODE; Set-Content -LiteralPath '$done' -Value \`$code -NoNewline; exit \`$code"; $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($taskScript)); $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -EncodedCommand $encoded"; $principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited; Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Force | Out-Null; try { Start-ScheduledTask -TaskName $task; $deadline=[DateTime]::UtcNow.AddSeconds(${seconds + 15}); do { Start-Sleep -Seconds 1 } while(-not (Test-Path -LiteralPath $donePath) -and [DateTime]::UtcNow -lt $deadline); $ended=[DateTime]::UtcNow; if(-not (Test-Path -LiteralPath $donePath)){ Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2; throw 'Scheduled Task recording timed out (done marker not written; task stopped)' }; if(-not(Test-Path -LiteralPath $startedPath)){ throw 'Scheduled Task did not write recording start time' }; $exitCode=(Get-Content -Raw -LiteralPath $donePath).Trim(); if($exitCode -notmatch '^-?\\d+$' -or [int]$exitCode -ne 0){ throw ('ffmpeg exited with code ' + $exitCode) }; $recorded=(Get-Content -Raw -LiteralPath $startedPath).Trim(); Write-Output ('recording_started_utc=' + $recorded); Write-Output ('recording_ended_utc=' + $ended.ToString('o')); Write-Output 'ffmpeg_log_begin'; if(Test-Path -LiteralPath $log){ Get-Content -Raw -LiteralPath $log }; Write-Output 'ffmpeg_log_end' } finally { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue }`;
    const recording = await runTextProcess(sshPowerShell(command), (seconds + 60) * 1_000);
    diagnostics = formatProcessDiagnostics('Windows Scheduled Task 録画', recording);
    if (recording.exitCode !== 0) return { samples: [], warning: 'Windows録画は失敗しました。Scheduled TaskのSSH/ffmpeg出力をplayer-error.mdで確認してください。', diagnostics };
    const startedAt = parseUtcMarker(recording.stdout, 'recording_started_utc');
    if (startedAt === null) return { samples: [], warning: 'Windows録画の実開始UTC時刻を取得できませんでした。', diagnostics };
    const endedAt = parseUtcMarker(recording.stdout, 'recording_ended_utc') ?? Date.now();
    const local = join(outDir, basename(remote));
    const size = await remoteFileSize(remote);
    diagnostics += `\n## 録画開始・終了（UTC）\n\n- 開始: ${new Date(startedAt).toISOString()}\n- 終了: ${new Date(endedAt).toISOString()}\n- 回収前サイズ: ${size} bytes\n`;
    if (size <= 0 || size > MAX_RECORDING_BYTES) return { samples: [], warning: `Windows録画の回収を中止しました（サイズ ${size} bytes、上限 2 GB）。`, diagnostics };
    const copied = await copyRemoteFile(remote, local);
    diagnostics += `\n## 回収 stderr\n\n${copied.stderr}\n`;
    if (!copied.ok) return { samples: [], warning: 'Windows録画は完了しましたが、Macへの回収に失敗しました。', diagnostics };
    const duration = await mediaDurationSeconds(local);
    const durationWarning = duration === null ? 'Windows録画の長さをffprobeで取得できませんでした。' : duration < seconds * 0.8 ? `Windows録画が指定時間の80%未満です（${duration.toFixed(2)} 秒 / 指定 ${seconds} 秒）。` : null;
    const offset = await windowsClockOffsetMs();
    diagnostics += `\n## w32tm 補正\n\n${offset.diagnostics}`;
    if (offset.valueMs === null) return { samples: [], warning: 'Windows時計差（w32tm）の取得または解析に失敗したため、プレイヤー計測は不成立です。', diagnostics };
    diagnostics += `- Windows - Mac: ${offset.valueMs.toFixed(3)} ms\n`;
    try { return { samples: await decodePlayerRecording(local, startedAt, offset.valueMs), warning: durationWarning, diagnostics }; }
    catch (error) { return { samples: [], warning: `Windows録画の復号に失敗しました: ${String(error)}`, diagnostics }; }
  } finally {
    const cleanup = await runTextProcess(sshPowerShell(`Remove-Item -LiteralPath ${remoteDir} -Recurse -Force -ErrorAction Stop`), 30_000).catch((error) => ({ stdout: '', stderr: String(error), exitCode: -1 }));
    if (cleanup.exitCode !== 0) console.warn(`Windows一時ディレクトリcleanupに失敗しました: ${cleanup.stderr}`);
  }
}

async function remoteFileSize(path: string): Promise<number> {
  const result = await runTextProcess(sshPowerShell(`(Get-Item -LiteralPath '${path}').Length`), 10 * 60_000);
  const size = Number(result.stdout.trim());
  if (result.exitCode !== 0 || !Number.isSafeInteger(size)) throw new Error(`Windows録画サイズを取得できませんでした: ${result.stderr.trim()}`);
  return size;
}

async function copyRemoteFile(remote: string, local: string): Promise<{ ok: boolean; stderr: string }> {
  const child = Bun.spawn(sshPowerShell(`$stream=[Console]::OpenStandardOutput(); $input=[IO.File]::OpenRead('${remote}'); try { $input.CopyTo($stream) } finally { $input.Dispose() }`), { stdout: 'pipe', stderr: 'pipe' });
  const stderrPromise = readPipeText(requirePipe(child.stderr, 'Windows recording copy stderr'));
  try {
    await Bun.write(Bun.file(local), new Response(requirePipe(child.stdout, 'Windows recording')));
    await chmod(local, 0o600);
    const exitCode = await waitForProcess(child, 10 * 60_000);
    const stderr = await stderrPromise;
    return { ok: exitCode === 0 && (await stat(local)).size > 0, stderr };
  } catch (error) {
    child.kill(); await child.exited.catch(() => undefined);
    return { ok: false, stderr: `${await stderrPromise.catch(() => '')}\n${String(error)}` };
  }
}

async function mediaDurationSeconds(file: string): Promise<number | null> {
  const result = await runTextProcess(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file], 30_000);
  const duration = Number(result.stdout.trim());
  return result.exitCode === 0 && Number.isFinite(duration) ? duration : null;
}

async function decodePlayerRecording(file: string, macStartedAtMs: number, offsetMs: number): Promise<LatencySample[]> {
  const { width, height } = await probeDimensionsFor(file);
  const child = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { stdout: 'pipe', stderr: 'pipe' });
  const frameBytes = width * height * 3; const samples: LatencySample[] = []; let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(); let frame = 0;
  for await (const chunk of requirePipe(child.stdout, 'player decode')) {
    pending = appendBytes(pending, chunk);
    while (pending.length >= frameBytes) {
      const timestamp = decodeBlockCodeFrame(pending.slice(0, frameBytes), width, height); pending = pending.slice(frameBytes);
      const observedAtMs = compensateClockOffset(macStartedAtMs + frame * (1_000 / 30), offsetMs);
      if (timestamp !== null) samples.push({ observedAtMs, videoLatencyMs: observedAtMs - timestamp, audioLatencyMs: null, audioLatencyPhaseMs: null });
      frame += 1;
    }
  }
  if (await child.exited !== 0) throw new Error('Windows recording decode failed');
  return samples;
}

async function windowsClockOffsetMs(): Promise<{ valueMs: number | null; diagnostics: string }> {
  const result = await runTextProcess([...sshBase(), 'win2022', 'w32tm /stripchart /computer:time.windows.com /samples:5 /dataonly'], 30_000);
  const values = [...result.stdout.matchAll(/([+-]\d+(?:\.\d+)?)s/g)].map((match) => Number(match[1]) * 1_000).filter(Number.isFinite);
  return { valueMs: result.exitCode === 0 && values.length ? values.reduce((total, value) => total + value, 0) / values.length : null, diagnostics: formatProcessDiagnostics('w32tm', result) };
}

function sshBase(): string[] { return ['ssh', ...SSH_OPTIONS, '--']; }
function sshPowerShell(script: string): string[] { return [...sshBase(), 'win2022', `powershell -NoProfile -EncodedCommand ${encodePowerShell(script)}`]; }
async function runTextProcess(command: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> { const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' }); const [stdout, stderr, exitCode] = await Promise.all([readPipeText(requirePipe(child.stdout, command[0] ?? 'process stdout')), readPipeText(requirePipe(child.stderr, command[0] ?? 'process stderr')), waitForProcess(child, timeoutMs)]); return { stdout, stderr, exitCode }; }
async function waitForProcess(child: Bun.Subprocess, timeoutMs: number): Promise<number> { let timeout: ReturnType<typeof setTimeout> | null = null; const timed = new Promise<number>((resolve) => { timeout = setTimeout(() => { child.kill(); resolve(-1); }, timeoutMs); }); const exitCode = await Promise.race([child.exited, timed]); if (timeout) clearTimeout(timeout); if (exitCode === -1) await child.exited.catch(() => undefined); return exitCode; }
function formatProcessDiagnostics(name: string, result: { stdout: string; stderr: string; exitCode: number }): string { return `# ${name}\n\nexit code: ${result.exitCode}\n\n## stdout\n\n${result.stdout}\n\n## stderr\n\n${result.stderr}\n`; }
function parseUtcMarker(text: string, key: string): number | null { const value = new RegExp(`^${key}=(.+)$`, 'm').exec(text)?.[1]; const parsed = value ? Date.parse(value) : Number.NaN; return Number.isFinite(parsed) ? parsed : null; }
function appendBytes(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> { const merged = new Uint8Array(left.length + right.length); merged.set(left); merged.set(right, left.length); return merged; }

/** PowerShell の -EncodedCommand 用に UTF-16LE の base64 へ変換する。 */
export function encodePowerShell(script: string): string { return Buffer.from(script, 'utf16le').toString('base64'); }
