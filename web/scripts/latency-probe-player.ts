import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { LatencySample } from './latency-probe-analysis';
import { compensateClockOffset, decodeBlockCodeFrame } from './latency-probe-codec';
import { probeDimensionsFor, readPipeText, requirePipe } from './latency-probe-observe';

/** Windows側計測の保存結果と診断情報。 */
export interface PlayerResult { samples: LatencySample[]; warning: string | null; diagnostics: string }

/** 対話WindowsセッションのScheduled Taskで録画し、復号標本を返す。 */
export async function recordWindowsPlayer(outDir: string, until: number): Promise<PlayerResult> {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1_000));
  const remote = 'C:\\Users\\win\\latency-harness.mp4';
  const log = 'C:\\Users\\win\\latency-harness-ffmpeg.log';
  const started = 'C:\\Users\\win\\latency-harness-started.txt';
  const ffmpeg = 'C:\\Users\\win\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-7.1.1-full_build\\bin\\ffmpeg.exe';
  const command = `$ErrorActionPreference='Stop'; $ff='${ffmpeg}'; $out='${remote}'; $log='${log}'; $startedPath='${started}'; $task='WebScreenLatencyHarness'; Remove-Item $startedPath -Force -ErrorAction SilentlyContinue; $taskScript="\`$recorded=[DateTime]::UtcNow; Set-Content -Path '$startedPath' -Value \`$recorded.ToString('o') -NoNewline; & '$ff' -y -f gdigrab -framerate 30 -i desktop -t ${seconds} '$out' 2>&1 | Set-Content -Path '$log'; exit \`$LASTEXITCODE"; $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($taskScript)); $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -EncodedCommand $encoded"; $principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited; Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Force | Out-Null; try { Start-ScheduledTask -TaskName $task; $deadline=[DateTime]::UtcNow.AddSeconds(${seconds + 15}); do { Start-Sleep -Seconds 1; $state=(Get-ScheduledTask -TaskName $task).State } while($state -eq 'Running' -and [DateTime]::UtcNow -lt $deadline); $ended=[DateTime]::UtcNow; if($state -eq 'Running'){ throw 'Scheduled Task recording timed out' }; if(-not(Test-Path $startedPath)){ throw 'Scheduled Task did not write recording start time' }; $recorded=(Get-Content -Raw $startedPath).Trim(); Write-Output ('recording_started_utc=' + $recorded); Write-Output ('recording_ended_utc=' + $ended.ToString('o')); Write-Output 'ffmpeg_log_begin'; if(Test-Path $log){ Get-Content -Raw $log }; Write-Output 'ffmpeg_log_end' } finally { Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue }`;
  const recording = await runTextProcess(['ssh', 'win2022', 'powershell', '-NoProfile', '-Command', command]);
  let diagnostics = formatProcessDiagnostics('Windows Scheduled Task 録画', recording);
  if (recording.exitCode !== 0) return { samples: [], warning: 'Windows録画は失敗しました。Scheduled TaskのSSH/ffmpeg出力をplayer-error.mdで確認してください。', diagnostics };
  const startedAt = parseUtcMarker(recording.stdout, 'recording_started_utc');
  if (startedAt === null) return { samples: [], warning: 'Windows録画の実開始UTC時刻を取得できませんでした。', diagnostics };
  const endedAt = parseUtcMarker(recording.stdout, 'recording_ended_utc') ?? Date.now();
  const local = join(outDir, basename(remote));
  const copy = Bun.spawn(['ssh', 'win2022', 'powershell', '-NoProfile', '-Command', `$stream=[Console]::OpenStandardOutput();$bytes=[IO.File]::ReadAllBytes('${remote}');$stream.Write($bytes,0,$bytes.Length)`], { stdout: 'pipe', stderr: 'pipe' });
  const copyError = readPipeText(requirePipe(copy.stderr, 'Windows recording copy stderr'));
  const bytes = await new Response(requirePipe(copy.stdout, 'Windows recording')).arrayBuffer();
  const copyExitCode = await copy.exited;
  diagnostics += `\n## 録画開始・終了（UTC）\n\n- 開始: ${new Date(startedAt).toISOString()}\n- 終了: ${new Date(endedAt).toISOString()}\n\n## 回収 stderr\n\n${await copyError}\n`;
  if (copyExitCode !== 0 || bytes.byteLength === 0) return { samples: [], warning: 'Windows録画は完了しましたが、Macへの回収に失敗しました。', diagnostics };
  await writeFile(local, new Uint8Array(bytes));
  const offset = await windowsClockOffsetMs();
  diagnostics += `\n## w32tm 補正\n\n- Windows - Mac: ${offset.valueMs.toFixed(3)} ms\n\n${offset.diagnostics}`;
  try {
    return { samples: await decodePlayerRecording(local, startedAt, offset.valueMs), warning: null, diagnostics };
  } catch (error) {
    return { samples: [], warning: `Windows録画の復号に失敗しました: ${String(error)}`, diagnostics };
  }
}

async function decodePlayerRecording(file: string, macStartedAtMs: number, offsetMs: number): Promise<LatencySample[]> {
  const { width, height } = await probeDimensionsFor(file);
  const child = Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', file, '-an', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { stdout: 'pipe', stderr: 'pipe' });
  const frameBytes = width * height * 3;
  const samples: LatencySample[] = [];
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let frame = 0;
  for await (const chunk of requirePipe(child.stdout, 'player decode')) {
    pending = appendBytes(pending, chunk);
    while (pending.length >= frameBytes) {
      const timestamp = decodeBlockCodeFrame(pending.slice(0, frameBytes), width, height);
      pending = pending.slice(frameBytes);
      const observedAtMs = compensateClockOffset(macStartedAtMs + frame * (1_000 / 30), offsetMs);
      if (timestamp !== null) samples.push({ observedAtMs, videoLatencyMs: observedAtMs - timestamp, audioLatencyMs: null });
      frame += 1;
    }
  }
  if (await child.exited !== 0) throw new Error('Windows recording decode failed');
  return samples;
}

async function windowsClockOffsetMs(): Promise<{ valueMs: number; diagnostics: string }> {
  const result = await runTextProcess(['ssh', 'win2022', 'w32tm', '/stripchart', '/computer:time.windows.com', '/samples:5', '/dataonly']);
  const values = [...result.stdout.matchAll(/([+-]\d+(?:\.\d+)?)s/g)].map((match) => Number(match[1]) * 1_000).filter(Number.isFinite);
  return { valueMs: result.exitCode === 0 && values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0, diagnostics: formatProcessDiagnostics('w32tm', result) };
}

async function runTextProcess(command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([readPipeText(requirePipe(child.stdout, command[0] ?? 'process stdout')), readPipeText(requirePipe(child.stderr, command[0] ?? 'process stderr')), child.exited]);
  return { stdout, stderr, exitCode };
}

function formatProcessDiagnostics(name: string, result: { stdout: string; stderr: string; exitCode: number }): string {
  return `# ${name}\n\nexit code: ${result.exitCode}\n\n## stdout\n\n${result.stdout}\n\n## stderr\n\n${result.stderr}\n`;
}

function parseUtcMarker(text: string, key: string): number | null {
  const value = new RegExp(`^${key}=(.+)$`, 'm').exec(text)?.[1];
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function appendBytes(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const merged = new Uint8Array(left.length + right.length); merged.set(left); merged.set(right, left.length); return merged;
}
