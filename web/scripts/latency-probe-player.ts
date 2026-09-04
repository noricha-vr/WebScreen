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
  // PowerShell に渡す式（二重引用符付き）。単一引用符だと $env:TEMP が展開されない
  const remoteDir = `"$env:TEMP\\webscreen-latency-${runId}"`;
  const remote = `"$env:TEMP\\webscreen-latency-${runId}\\recording.mp4"`;
  const log = `"$env:TEMP\\webscreen-latency-${runId}\\ffmpeg.log"`;
  const started = `"$env:TEMP\\webscreen-latency-${runId}\\started.txt"`;
  const done = `"$env:TEMP\\webscreen-latency-${runId}\\done.txt"`;
  // run ごとに一意な名前にして、前回の残骸や並行実行と衝突しないようにする（finally で必ず止めて消す）
  const taskName = `WebScreenLatencyHarness-${runId}`;
  const ffmpeg = 'C:\\Users\\win\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-7.1.1-full_build\\bin\\ffmpeg.exe';
  let diagnostics = '';
  try {
    // Scheduled Task を起動する ssh と、done マーカーを待つ ssh を分ける。1 本の ssh セッションで
    // 録画時間ぶん待つ方式は 8 分 run で stdout / stderr が空のまま exit 1 になり（2026-09-04、
    // 300 秒までは通る）、長い無出力セッションが途中で切れると録画が丸ごと失われるため。
    // 一時ディレクトリは Windows 側で $env:TEMP を展開してから __ROOT__ に差し込む（単一引用符リテラル内では展開されない）
    const taskScript = `$recorded=[DateTime]::UtcNow; Set-Content -LiteralPath '__ROOT__\\started.txt' -Value $recorded.ToString('o') -NoNewline; & '${ffmpeg}' -y -f gdigrab -framerate 30 -i desktop -t ${seconds} -c:v libx264 -preset ultrafast -tune zerolatency -pix_fmt yuv420p '__ROOT__\\recording.mp4' 2>&1 | Set-Content -LiteralPath '__ROOT__\\ffmpeg.log'; $code=$LASTEXITCODE; Set-Content -LiteralPath '__ROOT__\\done.txt' -Value ($code.ToString() + ' ' + [DateTime]::UtcNow.ToString('o')) -NoNewline; exit $code`;
    const startCommand = `$ErrorActionPreference='Stop'; $root=${remoteDir}; $task=${powerShellLiteral(taskName)}; Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Path $root -Force | Out-Null; $taskScript=${powerShellLiteral(taskScript)}.Replace('__ROOT__', $root.Replace("'", "''")); $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($taskScript)); $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -EncodedCommand $encoded"; $principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited; Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Force | Out-Null; Start-ScheduledTask -TaskName $task; Write-Output 'task_started'`;
    console.info(`[player] 録画タスク起動（${seconds} 秒、done 待ち期限 ${recordingDeadlineSeconds(seconds)} 秒）`);
    const startResult = await runTextProcess(sshPowerShell(startCommand), 60_000);
    diagnostics = formatProcessDiagnostics('Windows Scheduled Task 起動', startResult);
    if (startResult.exitCode !== 0 || !startResult.stdout.includes('task_started')) return { samples: [], warning: 'Windows録画タスクを起動できませんでした。player-error.mdのSSH出力を確認してください。', diagnostics };
    const doneMarker = await waitForDoneMarker(done, recordingDeadlineSeconds(seconds));
    diagnostics += `\n## done マーカー待ち\n\n${doneMarker.diagnostics}\n`;
    const finish = await runTextProcess(sshPowerShell(`$ErrorActionPreference='Continue'; Stop-ScheduledTask -TaskName ${powerShellLiteral(taskName)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${powerShellLiteral(taskName)} -Confirm:$false -ErrorAction SilentlyContinue; if(Test-Path -LiteralPath ${started}){ Write-Output ('recording_started_utc=' + (Get-Content -Raw -LiteralPath ${started}).Trim()) }; Write-Output 'ffmpeg_log_begin'; if(Test-Path -LiteralPath ${log}){ Get-Content -Raw -LiteralPath ${log} }; Write-Output 'ffmpeg_log_end'`), 60_000);
    const recording = { stdout: finish.stdout, stderr: finish.stderr, exitCode: doneMarker.exitCode };
    console.info(`[player] 録画完了 exit=${recording.exitCode} started=${parseUtcMarker(recording.stdout, 'recording_started_utc')}`);
    diagnostics += formatProcessDiagnostics('Windows Scheduled Task 録画', recording);
    if (recording.exitCode !== 0) return { samples: [], warning: 'Windows録画は失敗しました。Scheduled TaskのSSH/ffmpeg出力をplayer-error.mdで確認してください。', diagnostics };
    const startedAt = parseUtcMarker(recording.stdout, 'recording_started_utc');
    if (startedAt === null) return { samples: [], warning: 'Windows録画の実開始UTC時刻を取得できませんでした。', diagnostics };
    const endedAt = doneMarker.endedAtMs ?? Date.now();
    const local = join(outDir, 'recording.mp4');
    const size = await remoteFileSize(remote);
    console.info(`[player] リモートサイズ ${size} bytes。回収開始`);
    diagnostics += `\n## 録画開始・終了（UTC）\n\n- 開始: ${new Date(startedAt).toISOString()}\n- 終了: ${new Date(endedAt).toISOString()}\n- 回収前サイズ: ${size} bytes\n`;
    if (size <= 0 || size > MAX_RECORDING_BYTES) return { samples: [], warning: `Windows録画の回収を中止しました（サイズ ${size} bytes、上限 2 GB）。`, diagnostics };
    const copied = await copyRemoteFile(remote, local);
    console.info(`[player] 回収完了 ok=${copied.ok}`);
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
    // 起動 ssh が切れた後にタスクだけ残ると次回の Register -Force と衝突するので、成否に関わらず必ず止めて消す
    const cleanup = await runTextProcess(sshPowerShell(`$ErrorActionPreference='Continue'; Stop-ScheduledTask -TaskName ${powerShellLiteral(taskName)} -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName ${powerShellLiteral(taskName)} -Confirm:$false -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ${remoteDir} -Recurse -Force -ErrorAction Stop`), 30_000).catch((error) => ({ stdout: '', stderr: String(error), exitCode: -1 }));
    if (cleanup.exitCode !== 0) console.warn(`Windows一時ディレクトリcleanupに失敗しました: ${cleanup.stderr}`);
  }
}

/** PowerShell の単一引用符リテラル（' を '' に二重化）。 */
function powerShellLiteral(value: string): string { return `'${value.replace(/'/g, "''")}'`; }

/**
 * done マーカー（"<exit code> <ended UTC ISO>"）を短い ssh で定期的に読む。ssh の一時失敗は数えるだけで
 * 待ちを続け、期限までにマーカーが出なければ exit -1 で返す。
 */
async function waitForDoneMarker(donePath: string, deadlineSeconds: number, pollMs = 20_000): Promise<{ exitCode: number; endedAtMs: number | null; diagnostics: string }> {
  const deadline = Date.now() + deadlineSeconds * 1_000;
  let polls = 0;
  let sshFailures = 0;
  let invalidMarkers = 0;
  while (Date.now() < deadline) {
    polls += 1;
    const result = await runTextProcess(sshPowerShell(`if(Test-Path -LiteralPath ${donePath}){ Get-Content -Raw -LiteralPath ${donePath} } else { Write-Output 'pending' }`), 45_000);
    if (result.exitCode !== 0) sshFailures += 1;
    else {
      const text = result.stdout.trim();
      const match = /^(-?\d+)\s+(\S+)$/.exec(text);
      const endedAtMs = match ? Date.parse(match[2]!) : Number.NaN;
      // 形式は "<exit code> <ended UTC ISO>"。時刻が読めないマーカーは書きかけ・破損とみなし、次のポーリングで読み直す
      if (match && Number.isFinite(endedAtMs)) return { exitCode: Number(match[1]), endedAtMs, diagnostics: `- polls: ${polls}\n- ssh failures: ${sshFailures}\n- marker: ${text}` };
      if (text !== 'pending') invalidMarkers += 1;
    }
    await Bun.sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
  return { exitCode: -1, endedAtMs: null, diagnostics: `- polls: ${polls}\n- ssh failures: ${sshFailures}\n- invalid markers: ${invalidMarkers}\n- marker: (timed out after ${deadlineSeconds} s)` };
}

async function remoteFileSize(path: string): Promise<number> {
  const result = await runTextProcess(sshPowerShell(`(Get-Item -LiteralPath ${path}).Length`), 10 * 60_000);
  const size = Number(result.stdout.trim());
  if (result.exitCode !== 0 || !Number.isSafeInteger(size)) throw new Error(`Windows録画サイズを取得できませんでした: ${result.stderr.trim()}`);
  return size;
}

async function copyRemoteFile(remote: string, local: string): Promise<{ ok: boolean; stderr: string }> {
  // stdout ストリーミング転送は ssh 終了後も Bun 側が待ち続けて固まったため（2026-09-02 実測）、scp で回収する。
  // remote は PowerShell 式（"$env:TEMP\..."）なので、先に Windows 側で実パスへ解決する
  const resolved = await runTextProcess(sshPowerShell(`Write-Output ${remote}`), 30_000);
  const remotePath = resolved.stdout.trim().split(/\r?\n/).pop() ?? '';
  if (resolved.exitCode !== 0 || !/^[A-Za-z]:\\/.test(remotePath)) return { ok: false, stderr: `リモートパスを解決できません: ${resolved.stderr.trim()}` };
  // Windows OpenSSH には SFTP サブシステムが無く既定の scp（SFTP 方式）は失敗するため、旧プロトコル -O を使う
  const scp = await runTextProcess(['scp', '-O', ...SSH_OPTIONS, '--', `win2022:${remotePath.replace(/\\/g, '/')}`, local], 10 * 60_000);
  if (scp.exitCode !== 0) return { ok: false, stderr: scp.stderr };
  await chmod(local, 0o600);
  return { ok: (await stat(local)).size > 0, stderr: scp.stderr };
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

/**
 * Scheduled Task 側の done マーカー待ち期限。VRChat 起動中は gdigrab + x264 が実時間より遅くなり
 * （2026-09-04 実測: 10 秒の録画が 25 秒で終わらない）、`seconds + 15` では長尺ほど確実に落ちる。
 * ultrafast でも余裕を持たせ、実時間の 1.5 倍 + 起動・flush の 30 秒を待つ。
 */
export function recordingDeadlineSeconds(seconds: number): number { return Math.ceil(seconds * 1.5) + 30; }

function sshBase(): string[] { return ['ssh', ...SSH_OPTIONS, '--']; }
function sshPowerShell(script: string): string[] { return [...sshBase(), 'win2022', `powershell -NoProfile -EncodedCommand ${encodePowerShell(script)}`]; }
async function runTextProcess(command: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> { const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' }); const [stdout, stderr, exitCode] = await Promise.all([readPipeText(requirePipe(child.stdout, command[0] ?? 'process stdout')), readPipeText(requirePipe(child.stderr, command[0] ?? 'process stderr')), waitForProcess(child, timeoutMs)]); return { stdout, stderr, exitCode }; }
async function waitForProcess(child: Bun.Subprocess, timeoutMs: number): Promise<number> { let timeout: ReturnType<typeof setTimeout> | null = null; const timed = new Promise<number>((resolve) => { timeout = setTimeout(() => { child.kill(); resolve(-1); }, timeoutMs); }); const exitCode = await Promise.race([child.exited, timed]); if (timeout) clearTimeout(timeout); if (exitCode === -1) await child.exited.catch(() => undefined); return exitCode; }
function formatProcessDiagnostics(name: string, result: { stdout: string; stderr: string; exitCode: number }): string { return `# ${name}\n\nexit code: ${result.exitCode}\n\n## stdout\n\n${result.stdout}\n\n## stderr\n\n${result.stderr}\n`; }
function parseUtcMarker(text: string, key: string): number | null { const value = new RegExp(`^${key}=(.+)$`, 'm').exec(text)?.[1]; const parsed = value ? Date.parse(value) : Number.NaN; return Number.isFinite(parsed) ? parsed : null; }
function appendBytes(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> { const merged = new Uint8Array(left.length + right.length); merged.set(left); merged.set(right, left.length); return merged; }

/** PowerShell の -EncodedCommand 用に UTF-16LE の base64 へ変換する。 */
export function encodePowerShell(script: string): string { return Buffer.from(script, 'utf16le').toString('base64'); }

/** 実測の前に Windows 録画だけを短時間試し、録画長・サイズ・診断を返す（配信は不要）。 */
export async function checkWindowsRecording(outDir: string, seconds: number): Promise<{ ok: boolean; durationSeconds: number | null; diagnostics: string; warning: string | null }> {
  const result = await recordWindowsPlayer(outDir, Date.now() + seconds * 1_000);
  const file = join(outDir, 'recording.mp4');
  let durationSeconds: number | null = null;
  try {
    const probe = await runTextProcess(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 30_000);
    durationSeconds = probe.exitCode === 0 ? Number(probe.stdout.trim()) : null;
  } catch { durationSeconds = null; }
  return { ok: result.warning === null && durationSeconds !== null && durationSeconds >= seconds * 0.8, durationSeconds, diagnostics: result.diagnostics, warning: result.warning };
}
