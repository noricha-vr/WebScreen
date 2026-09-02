import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { formatLatencyCsv, formatSummary, type LatencySample } from './latency-probe-analysis';
import { compensateClockOffset, decodeBlockCodeFrame, detectBeepOnsets } from './latency-probe-codec';

const SOURCE_TITLE = 'WebScreen Latency Source';
const ACTIVE_FILE = resolve('..', 'docs', 'tmp', 'latency', '.active.json');
const SOURCE_FILE = Bun.file(new URL('./latency-source.html', import.meta.url));

/** 実行時に固定する遅延ハーネスの引数。 */
export interface RunOptions {
  minutes: number;
  source: string;
  player: 'win2022' | null;
  profileDir: string;
  outDir: string;
}

interface ActiveController { endpoint: string; sourceUrl: string }
interface ControllerState { sourcePage: import('@playwright/test').Page | null; sourceUrl: string }
interface PlayerResult { samples: LatencySample[]; warning: string | null }

/** 実Chromeの画面共有、出口プローブ、出力保存を同じcleanup境界で実行する。 */

const browserLog: string[] = [];
function pushBrowserLog(line: string): void {
  browserLog.push(`${new Date().toISOString()} ${line}`);
  if (browserLog.length > 80) browserLog.shift();
}
function browserLogTail(): string {
  return browserLog.length ? `\nbrowser console:\n${browserLog.slice(-30).join('\n')}` : '';
}
export async function runLatencyProbe(options: RunOptions): Promise<void> {
  requireCommands(options.player);
  await mkdir(options.outDir, { recursive: true });
  const sourceServer = startSourceServer();
  const state: ControllerState = { sourcePage: null, sourceUrl: sourceServer.url.href };
  const controllerServer = startControllerServer(state);
  await mkdir(resolve('..', 'docs', 'tmp', 'latency'), { recursive: true });
  await writeFile(ACTIVE_FILE, JSON.stringify({ endpoint: controllerServer.url.href, sourceUrl: sourceServer.url.href }));
  const startedAtMs = Date.now();
  const outlet: LatencySample[] = [];
  let browser: import('@playwright/test').BrowserContext | null = null;
  let video: Bun.Subprocess | null = null;
  let audio: Bun.Subprocess | null = null;
  let playerResult: PlayerResult | null = null;
  try {
    browser = await startChrome(options.profileDir);
    const pages = browser.pages();
    const sourcePage = pages[0] ?? await browser.newPage();
    state.sourcePage = sourcePage;
    await sourcePage.goto(sourceServer.url.href, { waitUntil: 'domcontentloaded' });
    const sharingPage = await browser.newPage();
    // 失敗時の原因切り分け用にブラウザ側のログを保持する（配信開始は製品 UI 経由なので、ここでしか見えない）
    sharingPage.on('console', (message) => pushBrowserLog(`[${message.type()}] ${message.text()}`));
    sharingPage.on('pageerror', (error) => pushBrowserLog(`[pageerror] ${error.message}`));
    sharingPage.on('response', (response) => {
      const url = response.url();
      if (response.status() >= 400 || url.includes('/api/streams') || url.includes('/whip')) {
        pushBrowserLog(`[http ${response.status()}] ${response.request().method()} ${url}`);
      }
    });
    sharingPage.on('requestfailed', (request) => pushBrowserLog(`[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));
    await sharingPage.goto('https://web-screen.net/ja/screen-share/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const streamId = await startScreenShare(sharingPage, options.profileDir);
    const target = resolveSourceUrl(options.source, sourceServer.url);
    if (target !== sourceServer.url.href) await sourcePage.goto(target, { waitUntil: 'domcontentloaded' });
    const rtspUrl = `rtsp://webscreen.tv/live/${streamId}`;
    const dimensions = await probeDimensions(rtspUrl);
    video = startVideoProbe(rtspUrl);
    audio = startAudioProbe(rtspUrl);
    state.sourceUrl = target;
    const until = startedAtMs + options.minutes * 60_000;
    const videoPump = collectVideo(requirePipe(video.stdout, 'video'), dimensions.width, dimensions.height, until, outlet);
    const audioPump = collectAudio(requirePipe(audio.stdout, 'audio'), until, outlet);
    const playerPump = options.player
      ? recordWindowsPlayer(options, until).catch((error) => ({ samples: [], warning: `Windows計測は失敗しました: ${String(error)}` }))
      : Promise.resolve(null);
    const [, , resolvedPlayer] = await Promise.all([videoPump, audioPump, playerPump]);
    playerResult = resolvedPlayer;
    await persistResults(options.outDir, outlet, startedAtMs, playerResult);
  } finally {
    video?.kill();
    audio?.kill();
    await browser?.close();
    controllerServer.stop(true);
    sourceServer.stop(true);
    await rm(ACTIVE_FILE, { force: true });
  }
}

/** 動作中のハーネスへ、共有済みタブの遷移先を渡す。 */
/**
 * ハーネスが起動する Chrome の中で人に一度ログインしてもらい、Cookie をプロファイルへ残す。
 * Playwright 起動の Chrome（mock keychain）は手動 Chrome が Keychain で暗号化した Cookie を読めないため、
 * 手動 Chrome でのログインは流用できない。ログイン自体は自動化しない（Discord OAuth）。
 */
export async function loginProfile(profileDir: string, timeoutMs = 8 * 60_000): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  const browser = await startChrome(profileDir);
  try {
    const page = browser.pages()[0] ?? await browser.newPage();
    await page.goto('https://web-screen.net/ja/screen-share/', { waitUntil: 'domcontentloaded' });
    console.info(`開いた Chrome で WebScreen にログインしてください（最大 ${Math.round(timeoutMs / 60_000)} 分待ちます）`);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const cookies = await browser.cookies('https://web-screen.net');
      if (cookies.some((cookie) => cookie.name === 'ws_session')) {
        console.info('ログインを確認しました。Cookie をプロファイルに保存して閉じます');
        await page.waitForTimeout(1_500);
        return;
      }
      await page.waitForTimeout(2_000);
    }
    throw new Error('ログインを確認できないまま待機時間を超えました');
  } finally {
    await browser.close();
  }
}

export async function switchSource(url: string): Promise<void> {
  const active = JSON.parse(await readFile(ACTIVE_FILE, 'utf8')) as ActiveController;
  const response = await fetch(new URL('/source', active.endpoint), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
  });
  if (!response.ok) throw new Error(`source switch failed: ${await response.text()}`);
}

/** 保存済み生CSVからsummaryを再生成する。 */
export async function analyzeDirectory(directory: string): Promise<void> {
  const { inferLatencyStartedAtMs, parseLatencyCsv } = await import('./latency-probe-analysis');
  const outletText = await readFile(join(directory, 'outlet.csv'), 'utf8');
  const outlet = parseLatencyCsv(outletText);
  const playerPath = join(directory, 'player.csv');
  const player = await Bun.file(playerPath).exists() ? parseLatencyCsv(await readFile(playerPath, 'utf8')) : null;
  const startedAtMs = inferLatencyStartedAtMs(outletText) ?? Math.min(...outlet.map((sample) => sample.observedAtMs));
  await writeFile(join(directory, 'summary.md'), formatSummary(outlet, player, startedAtMs));
}

function startSourceServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/' || path === '/latency-source.html') {
        return new Response(SOURCE_FILE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return new Response('Not found', { status: 404 });
    },
  });
}

function startControllerServer(state: ControllerState): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'POST' || url.pathname !== '/source') return new Response('Not found', { status: 404 });
      const body = await request.json().catch(() => null) as { url?: unknown } | null;
      if (!body || typeof body.url !== 'string') return new Response('url is required', { status: 400 });
      const target = resolveSourceUrl(body.url, new URL(state.sourceUrl));
      if (!state.sourcePage) return new Response('run is not ready', { status: 409 });
      await state.sourcePage.goto(target, { waitUntil: 'domcontentloaded' });
      state.sourceUrl = target;
      return Response.json({ ok: true, sourceUrl: target });
    },
  });
}

async function startChrome(profileDir: string): Promise<import('@playwright/test').BrowserContext> {
  const { chromium } = await import('@playwright/test');
  return chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', headless: false, viewport: null,
    args: [
      `--auto-select-tab-capture-source-by-title=${SOURCE_TITLE}`,
      '--autoplay-policy=no-user-gesture-required', '--start-maximized',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    ],
  });
}

async function startScreenShare(page: import('@playwright/test').Page, profileDir: string): Promise<string> {
  await page.locator('[data-screen-start]').click({ timeout: 15_000 });
  const isSettled = () => {
    const url = document.querySelector<HTMLInputElement>('[data-screen-url]')?.value;
    const login = document.querySelector<HTMLElement>('[data-screen-step="login"]');
    const stopOthers = document.querySelector<HTMLElement>('[data-screen-stop-others]');
    const stopOthersVisible = Boolean(stopOthers && !stopOthers.hidden && stopOthers.offsetParent !== null);
    return Boolean(url) || Boolean(login && !login.hidden) || stopOthersVisible;
  };
  await page.waitForFunction(isSettled, undefined, { timeout: 30_000 });
  // 同時配信上限（既定 1）に当たった時は、製品 UI の「他の配信を終了して開始」経路で既存配信を終えて始める。
  // 計測用に既存配信を奪う挙動なので、run の起動前にリードが利用者の了承を得ている前提
  const stopOthers = page.locator('[data-screen-stop-others]');
  if (await stopOthers.isVisible().catch(() => false)) {
    console.info('既存の配信を終了して開始します（同時配信上限）');
    await stopOthers.click({ timeout: 15_000 });
    await page.waitForFunction(() => {
      const url = document.querySelector<HTMLInputElement>('[data-screen-url]')?.value;
      const login = document.querySelector<HTMLElement>('[data-screen-step="login"]');
      return Boolean(url) || Boolean(login && !login.hidden);
    }, undefined, { timeout: 45_000 }).catch(async (error: unknown) => {
      const shot = `${profileDir}/last-stop-others-failure.png`;
      await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
      const texts = await page.locator('[data-screen-error], [role="alert"], [data-screen-status]').allInnerTexts().catch(() => []);
      throw new Error(`既存配信の終了後に配信 URL が表示されませんでした: ${error instanceof Error ? error.message : String(error)} / 画面: ${shot} / 表示: ${texts.join(' | ')}${browserLogTail()}`);
    });
  }
  const url = await page.locator('[data-screen-url]').inputValue().catch(() => '');
  if (!url) {
    // 原因切り分け用に画面を残す（ログイン未済 / 上限エラー / その他の表示を区別する）
    const shot = `${profileDir}/last-start-failure.png`;
    await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    const visibleText = await page.locator('[data-screen-error], [role="alert"]').allInnerTexts().catch(() => []);
    throw new Error(`配信を開始できませんでした（ログイン未済か配信上限）。画面: ${shot}${visibleText.length ? ` / 表示: ${visibleText.join(' | ')}` : ''}。未ログインならこのプロファイルで一度ログインしてください: ${profileDir}${browserLogTail()}`);
  }
  const streamId = /\/live\/([A-Za-z0-9_-]+)/.exec(url)?.[1];
  if (!streamId) throw new Error(`画面共有URLからstream idを取得できません: ${url}`);
  return streamId;
}

async function probeDimensions(rtspUrl: string): Promise<{ width: number; height: number }> {
  return probeDimensionsFor(rtspUrl);
}

async function probeDimensionsFor(input: string): Promise<{ width: number; height: number }> {
  const process = Bun.spawn(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', input], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, exitCode] = await Promise.all([new Response(process.stdout).text(), process.exited]);
  if (exitCode !== 0) throw new Error('ffprobe could not read the RTSPT outlet');
  const [width, height] = stdout.trim().split(',').map(Number);
  if (!Number.isInteger(width) || !Number.isInteger(height)) throw new Error('ffprobe returned invalid video dimensions');
  return { width, height };
}

function startVideoProbe(rtspUrl: string): Bun.Subprocess {
  return Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay', '-use_wallclock_as_timestamps', '1', '-i', rtspUrl, '-an', '-vf', 'fps=5', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { stdout: 'pipe', stderr: 'pipe' });
}

function startAudioProbe(rtspUrl: string): Bun.Subprocess {
  return Bun.spawn(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-fflags', 'nobuffer', '-flags', 'low_delay', '-use_wallclock_as_timestamps', '1', '-i', rtspUrl, '-vn', '-map', '0:a:0?', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'], { stdout: 'pipe', stderr: 'pipe' });
}

async function collectVideo(stream: ReadableStream<Uint8Array>, width: number, height: number, until: number, output: LatencySample[]): Promise<void> {
  const frameBytes = width * height * 3;
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  for await (const chunk of stream) {
    pending = appendBytes(pending, chunk);
    while (pending.length >= frameBytes && Date.now() < until) {
      const frame = pending.slice(0, frameBytes); pending = pending.slice(frameBytes);
      const timestamp = decodeBlockCodeFrame(frame, width, height);
      if (timestamp !== null) output.push({ observedAtMs: Date.now(), videoLatencyMs: Date.now() - timestamp, audioLatencyMs: null });
    }
    if (Date.now() >= until) break;
  }
}

async function collectAudio(stream: ReadableStream<Uint8Array>, until: number, output: LatencySample[]): Promise<void> {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  for await (const chunk of stream) {
    pending = appendBytes(pending, chunk);
    const usable = pending.length - (pending.length % 4);
    if (!usable) continue;
    const pcm = new Float32Array(pending.buffer.slice(pending.byteOffset, pending.byteOffset + usable));
    pending = pending.slice(usable);
    for (const onset of detectBeepOnsets(pcm, 48_000)) {
      const observedAtMs = Date.now();
      const nearestSecond = Math.round(observedAtMs / 1_000) * 1_000;
      output.push({ observedAtMs, videoLatencyMs: null, audioLatencyMs: observedAtMs - nearestSecond + onset / 48 });
    }
    if (Date.now() >= until) break;
  }
}

async function recordWindowsPlayer(options: RunOptions, until: number): Promise<PlayerResult> {
  const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1_000));
  const remote = 'C:\\Users\\win\\latency-harness.mp4';
  const probe = 'C:\\Users\\win\\latency-harness-probe.mp4';
  const ffmpeg = 'C:\\Users\\win\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-7.1.1-full_build\\bin\\ffmpeg.exe';
  const command = `$ErrorActionPreference='Stop'; $ff='${ffmpeg}'; $probe='${probe}'; $out='${remote}'; & $ff -y -f gdigrab -framerate 30 -i desktop -t 2 $probe; $black=(& $ff -v error -i $probe -vf blackdetect=d=1:pix_th=0.10 -f null - 2>&1 | Select-String 'black_start:0'); if($black){$action=New-ScheduledTaskAction -Execute $ff -Argument \"-y -f gdigrab -framerate 30 -i desktop -t ${seconds} $out\"; $principal=New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited; Register-ScheduledTask -TaskName WebScreenLatencyHarness -Action $action -Principal $principal -Force | Out-Null; Start-ScheduledTask -TaskName WebScreenLatencyHarness; Start-Sleep -Seconds ${seconds + 2}; Unregister-ScheduledTask -TaskName WebScreenLatencyHarness -Confirm:$false}else{& $ff -y -f gdigrab -framerate 30 -i desktop -t ${seconds} $out}`;
  const macRecordingStartedAtMs = Date.now();
  const child = Bun.spawn(['ssh', 'win2022', 'powershell', '-NoProfile', '-Command', command], { stdout: 'pipe', stderr: 'pipe' });
  const exitCode = await child.exited;
  if (exitCode !== 0) return { samples: [], warning: 'Windows録画は失敗しました。Scheduled Taskフォールバックも失敗したため、SSHの対話desktopとffmpegを確認してください。' };
  const local = join(options.outDir, basename(remote));
  const copy = Bun.spawn(['ssh', 'win2022', 'powershell', '-NoProfile', '-Command', `$stream=[Console]::OpenStandardOutput();$bytes=[IO.File]::ReadAllBytes('${remote}');$stream.Write($bytes,0,$bytes.Length)`], { stdout: 'pipe', stderr: 'pipe' });
  const bytes = await new Response(requirePipe(copy.stdout, 'Windows recording')).arrayBuffer();
  if (await copy.exited !== 0 || bytes.byteLength === 0) return { samples: [], warning: 'Windows録画は完了しましたが、Macへの回収に失敗しました。' };
  await writeFile(local, new Uint8Array(bytes));
  const offset = await windowsClockOffsetMs();
  return { samples: await decodePlayerRecording(local, macRecordingStartedAtMs + 2_000, offset), warning: null };
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

async function windowsClockOffsetMs(): Promise<number> {
  const child = Bun.spawn(['ssh', 'win2022', 'w32tm', '/stripchart', '/computer:time.windows.com', '/samples:5', '/dataonly'], { stdout: 'pipe', stderr: 'pipe' });
  const [output, exitCode] = await Promise.all([new Response(requirePipe(child.stdout, 'Windows clock')).text(), child.exited]);
  if (exitCode !== 0) return 0;
  const values = [...output.matchAll(/([+-]\d+(?:\.\d+)?)s/g)].map((match) => Number(match[1]) * 1_000).filter(Number.isFinite);
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

async function persistResults(outDir: string, outlet: LatencySample[], startedAtMs: number, player: PlayerResult | null): Promise<void> {
  await writeFile(join(outDir, 'outlet.csv'), formatLatencyCsv(outlet, startedAtMs));
  if (player) {
    await writeFile(join(outDir, 'player.csv'), formatLatencyCsv(player.samples, startedAtMs));
    if (player.warning) await writeFile(join(outDir, 'player-error.md'), `${player.warning}\n`);
  }
  const summary = formatSummary(outlet, player?.samples ?? null, startedAtMs) + (player?.warning ? `\n## プレイヤー側\n\n- ${player.warning}\n` : '');
  await writeFile(join(outDir, 'summary.md'), summary);
}

function resolveSourceUrl(value: string, sourceServer: URL): string {
  const parsed = new URL(value);
  if (parsed.hostname === '127.0.0.1' && parsed.port === '0') parsed.port = sourceServer.port;
  return parsed.href;
}

function appendBytes(left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const merged = new Uint8Array(left.length + right.length); merged.set(left); merged.set(right, left.length); return merged;
}

function requirePipe(
  pipe: number | ReadableStream<Uint8Array> | undefined, name: string
): ReadableStream<Uint8Array> {
  if (!pipe || typeof pipe === 'number') throw new Error(`${name} probe pipe is unavailable`);
  return pipe;
}

function requireCommands(player: RunOptions['player']): void {
  const required = player ? ['ffmpeg', 'ffprobe', 'ssh'] : ['ffmpeg', 'ffprobe'];
  const missing = required.filter((command) => Bun.which(command) === null);
  if (missing.length) throw new Error(`必要なコマンドがありません: ${missing.join(', ')}。macOSでは brew install ffmpeg、sshはXcode Command Line Toolsを確認してください。`);
}
