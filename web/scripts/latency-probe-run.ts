import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { formatLatencyCsv, formatSummary, type LatencySample } from './latency-probe-analysis';
import {
  analyzeSavedOutletAudio, audioSamplesFromCapture, collectAudio, collectVideo, persistOutletArtifacts,
  decodeDurationSummary, probeDimensionsFor, readPipeText, requirePipe, scaledProbeDimensions, startAudioProbe, startVideoProbe, type VideoDiagnostics,
} from './latency-probe-observe';
import { recordWindowsPlayer, type PlayerResult } from './latency-probe-player';

const SOURCE_TITLE = 'WebScreen Latency Source';
const ACTIVE_FILE = resolve('..', 'docs', 'tmp', 'latency', '.active.json');
const SOURCE_FILE = Bun.file(new URL('./latency-source.html', import.meta.url));

/** 実行時に固定する遅延ハーネスの引数。 */
export interface RunOptions { minutes: number; source: string; player: 'win2022' | null; profileDir: string; outDir: string }
interface ActiveController { endpoint: string; sourceUrl: string }
interface ControllerState { sourcePage: import('@playwright/test').Page | null; sourceUrl: string; sourceServerUrl: string }

const browserLog: string[] = [];
function pushBrowserLog(line: string): void { browserLog.push(`${new Date().toISOString()} ${line}`); if (browserLog.length > 80) browserLog.shift(); }
function browserLogTail(): string { return browserLog.length ? `\nbrowser console:\n${browserLog.slice(-30).join('\n')}` : ''; }

/** 実Chromeの画面共有、出口プローブ、出力保存を同じcleanup境界で実行する。 */
export async function runLatencyProbe(options: RunOptions): Promise<void> {
  requireCommands(options.player);
  await mkdir(options.outDir, { recursive: true });
  const sourceServer = startSourceServer();
  const state: ControllerState = { sourcePage: null, sourceUrl: sourceServer.url.href, sourceServerUrl: sourceServer.url.href };
  const controllerServer = startControllerServer(state);
  await mkdir(resolve('..', 'docs', 'tmp', 'latency'), { recursive: true });
  await writeFile(ACTIVE_FILE, JSON.stringify({ endpoint: controllerServer.url.href, sourceUrl: sourceServer.url.href }));
  let startedAtMs = 0;
  const outlet: LatencySample[] = [];
  let browser: import('@playwright/test').BrowserContext | null = null;
  let video: Bun.Subprocess | null = null;
  let audio: Bun.Subprocess | null = null;
  try {
    browser = await startChrome(options.profileDir);
    const sourcePage = browser.pages()[0] ?? await browser.newPage();
    state.sourcePage = sourcePage;
    await sourcePage.goto(sourceServer.url.href, { waitUntil: 'domcontentloaded' });
    const sharingPage = await browser.newPage();
    attachBrowserLog(sharingPage);
    await sharingPage.goto('https://web-screen.net/ja/screen-share/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const streamId = await startScreenShare(sharingPage, options.profileDir);
    const target = resolveSourceUrl(options.source, sourceServer.url);
    if (target !== sourceServer.url.href) await sourcePage.goto(target, { waitUntil: 'domcontentloaded' });
    await sourcePage.bringToFront();
    const rtspUrl = `rtsp://webscreen.tv/live/${streamId}`;
    // VRChat へ貼る URL を人に渡す経路（クリップボードと固定ファイル）。run はこの後ブロックするため、
    // 標準出力だけだと貼るタイミングで URL を伝えられない
    const viewerUrl = `rtspt://webscreen.tv/live/${streamId}`;
    console.info(`配信 URL: ${viewerUrl}`);
    await writeFile(join(options.profileDir, 'current-stream-url.txt'), `${viewerUrl}\n`).catch(() => undefined);
    if (process.platform === 'darwin') {
      const pbcopy = Bun.spawn(['pbcopy'], { stdin: 'pipe' });
      pbcopy.stdin.write(viewerUrl);
      pbcopy.stdin.end();
      await pbcopy.exited;
    }
    const dimensions = scaledProbeDimensions(await probeDimensionsFor(rtspUrl));
    video = startVideoProbe(rtspUrl);
    audio = startAudioProbe(rtspUrl);
    const videoLog = readPipeText(requirePipe(video.stderr, 'video stderr'));
    const audioLog = readPipeText(requirePipe(audio.stderr, 'audio stderr'));
    state.sourceUrl = target;
    startedAtMs = Date.now();
    const until = startedAtMs + options.minutes * 60_000;
    const diagnostics: VideoDiagnostics = { firstDecoded: null, lastDecoded: null, lastFailure: null, decodeLog: [], lastLoggedFailureAtMs: null, decodeCount: 0, decodeMsTotal: 0, decodeMsMax: 0 };
    const playerPump = options.player ? recordWindowsPlayer(options.outDir, until).catch((error) => ({ samples: [], warning: `Windows計測は失敗しました: ${String(error)}`, diagnostics: String(error) } satisfies PlayerResult)) : Promise.resolve(null);
    const [, capturedAudio, player] = await Promise.all([
      collectVideo(requirePipe(video.stdout, 'video'), dimensions.width, dimensions.height, until, outlet, diagnostics, video),
      collectAudio(requirePipe(audio.stdout, 'audio'), until), playerPump,
    ]);
    outlet.push(...audioSamplesFromCapture(capturedAudio));
    const videoExitBeforeStop = video.exitCode;
    const audioExitBeforeStop = audio.exitCode;
    if (videoExitBeforeStop === null) video.kill();
    if (audioExitBeforeStop === null) audio.kill();
    await Promise.all([video.exited, audio.exited]);
    const [videoStderr, audioStderr] = await Promise.all([videoLog, audioLog]);
    diagnostics.decodeLog.push(`${new Date().toISOString()} ${decodeDurationSummary(diagnostics)}`);
    await persistOutletArtifacts(options.outDir, startedAtMs, capturedAudio, dimensions, diagnostics, videoStderr, audioStderr);
    const failures = [
      videoExitBeforeStop !== null && videoExitBeforeStop !== 0 ? `video ffmpeg exit=${videoExitBeforeStop}\n${videoStderr}` : null,
      audioExitBeforeStop !== null && audioExitBeforeStop !== 0 ? `audio ffmpeg exit=${audioExitBeforeStop}\n${audioStderr}` : null,
    ].filter((failure): failure is string => failure !== null);
    if (failures.length) throw new Error(`出口ffmpegが計測終了前に失敗しました。outlet-ffmpeg.logを保存しました。\n${failures.join('\n')}`);
    await persistResults(options.outDir, outlet, startedAtMs, player);
  } finally {
    video?.kill(); audio?.kill();
    await browser?.close();
    controllerServer.stop(true); sourceServer.stop(true);
    await rm(ACTIVE_FILE, { force: true });
  }
}

/** ハーネスが起動するChromeに手動ログインし、プロファイルへCookieを残す。 */
export async function loginProfile(profileDir: string, timeoutMs = 8 * 60_000): Promise<void> {
  await mkdir(profileDir, { recursive: true });
  const browser = await startChrome(profileDir);
  try {
    const page = browser.pages()[0] ?? await browser.newPage();
    await page.goto('https://web-screen.net/ja/screen-share/', { waitUntil: 'domcontentloaded' });
    console.info(`開いた Chrome で WebScreen にログインしてください（最大 ${Math.round(timeoutMs / 60_000)} 分待ちます）`);
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if ((await browser.cookies('https://web-screen.net')).some((cookie) => cookie.name === 'ws_session')) {
        console.info('ログインを確認しました。Cookie をプロファイルに保存して閉じます'); await page.waitForTimeout(1_500); return;
      }
      await page.waitForTimeout(2_000);
    }
    throw new Error('ログインを確認できないまま待機時間を超えました');
  } finally { await browser.close(); }
}

/** 動作中ハーネスの共有済みタブを指定URLへ遷移する。 */
export async function switchSource(url: string): Promise<void> {
  const active = JSON.parse(await readFile(ACTIVE_FILE, 'utf8')) as ActiveController;
  const response = await fetch(new URL('/source', active.endpoint), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
  if (!response.ok) throw new Error(`source switch failed: ${await response.text()}`);
}

/** 保存済み生CSVと音声WAVからsummaryと音声標本を再生成する。 */
export async function analyzeDirectory(directory: string): Promise<void> {
  const { inferLatencyStartedAtMs, parseLatencyCsv } = await import('./latency-probe-analysis');
  const outletText = await readFile(join(directory, 'outlet.csv'), 'utf8');
  const outlet = parseLatencyCsv(outletText);
  const playerPath = join(directory, 'player.csv');
  const player = await Bun.file(playerPath).exists() ? parseLatencyCsv(await readFile(playerPath, 'utf8')) : null;
  const startedAtMs = inferLatencyStartedAtMs(outletText) ?? Math.min(...outlet.map((sample) => sample.observedAtMs));
  const audio = await analyzeSavedOutletAudio(directory);
  if (audio) await writeFile(join(directory, 'outlet-audio.csv'), formatLatencyCsv(audio, startedAtMs));
  await writeFile(join(directory, 'summary.md'), formatSummary(outlet, player, startedAtMs));
}

async function persistResults(outDir: string, outlet: LatencySample[], startedAtMs: number, player: PlayerResult | null): Promise<void> {
  await writeFile(join(outDir, 'outlet.csv'), formatLatencyCsv(outlet, startedAtMs));
  if (player) {
    await writeFile(join(outDir, 'player.csv'), formatLatencyCsv(player.samples, startedAtMs));
    await writeFile(join(outDir, 'player-recording.md'), player.diagnostics);
    if (player.warning) await writeFile(join(outDir, 'player-error.md'), `${player.warning}\n\n${player.diagnostics}`);
  }
  const playerWarning = player?.warning ? `\n## プレイヤー側\n\n- ${player.warning}\n` : '';
  await writeFile(join(outDir, 'summary.md'), formatSummary(outlet, player?.samples ?? null, startedAtMs) + playerWarning);
}

function startSourceServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    return path === '/' || path === '/latency-source.html' ? new Response(SOURCE_FILE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : new Response('Not found', { status: 404 });
  } });
}

function startControllerServer(state: ControllerState): ReturnType<typeof Bun.serve> {
  return Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/source') return new Response('Not found', { status: 404 });
    const body = await request.json().catch(() => null) as { url?: unknown } | null;
    if (!body || typeof body.url !== 'string') return new Response('url is required', { status: 400 });
    const target = resolveSourceUrl(body.url, new URL(state.sourceServerUrl));
    if (!state.sourcePage) return new Response('run is not ready', { status: 409 });
    await state.sourcePage.goto(target, { waitUntil: 'domcontentloaded' }); state.sourceUrl = target;
    return Response.json({ ok: true, sourceUrl: target });
  } });
}

async function startChrome(profileDir: string): Promise<import('@playwright/test').BrowserContext> {
  const { chromium } = await import('@playwright/test');
  return chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: false, viewport: null, args: [
    `--auto-select-tab-capture-source-by-title=${SOURCE_TITLE}`, '--autoplay-policy=no-user-gesture-required', '--start-maximized',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
  ] });
}

function attachBrowserLog(page: import('@playwright/test').Page): void {
  page.on('console', (message) => pushBrowserLog(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => pushBrowserLog(`[pageerror] ${error.message}`));
  page.on('response', (response) => { const url = response.url(); if (response.status() >= 400 || url.includes('/api/streams') || url.includes('/whip')) pushBrowserLog(`[http ${response.status()}] ${response.request().method()} ${url}`); });
  page.on('requestfailed', (request) => pushBrowserLog(`[requestfailed] ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`));
}

async function startScreenShare(page: import('@playwright/test').Page, profileDir: string): Promise<string> {
  await page.locator('[data-screen-start]').click({ timeout: 15_000 });
  await page.waitForFunction(() => {
    const url = document.querySelector<HTMLInputElement>('[data-screen-url]')?.value;
    const login = document.querySelector<HTMLElement>('[data-screen-step="login"]');
    const stopOthers = document.querySelector<HTMLElement>('[data-screen-stop-others]');
    return Boolean(url) || Boolean(login && !login.hidden) || Boolean(stopOthers && !stopOthers.hidden && stopOthers.offsetParent !== null);
  }, undefined, { timeout: 30_000 });
  const stopOthers = page.locator('[data-screen-stop-others]');
  if (await stopOthers.isVisible().catch(() => false)) {
    console.info('既存の配信を終了して開始します（同時配信上限）'); await stopOthers.click({ timeout: 15_000 });
    await page.waitForFunction(() => Boolean(document.querySelector<HTMLInputElement>('[data-screen-url]')?.value) || Boolean(document.querySelector<HTMLElement>('[data-screen-step="login"]') && !document.querySelector<HTMLElement>('[data-screen-step="login"]')?.hidden), undefined, { timeout: 45_000 });
  }
  const url = await page.locator('[data-screen-url]').inputValue().catch(() => '');
  if (!url) {
    const shot = `${profileDir}/last-start-failure.png`; await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
    const visibleText = await page.locator('[data-screen-error], [role="alert"]').allInnerTexts().catch(() => []);
    throw new Error(`配信を開始できませんでした（ログイン未済か配信上限）。画面: ${shot}${visibleText.length ? ` / 表示: ${visibleText.join(' | ')}` : ''}。未ログインならこのプロファイルで一度ログインしてください: ${profileDir}${browserLogTail()}`);
  }
  const streamId = /\/live\/([A-Za-z0-9_-]+)/.exec(url)?.[1];
  if (!streamId) throw new Error(`画面共有URLからstream idを取得できません: ${url}`);
  return streamId;
}

function resolveSourceUrl(value: string, sourceServer: URL): string { const parsed = new URL(value); if (parsed.hostname === '127.0.0.1' && parsed.port === '0') parsed.port = sourceServer.port; return parsed.href; }
function requireCommands(player: RunOptions['player']): void { const required = player ? ['ffmpeg', 'ffprobe', 'ssh'] : ['ffmpeg', 'ffprobe']; const missing = required.filter((command) => Bun.which(command) === null); if (missing.length) throw new Error(`必要なコマンドがありません: ${missing.join(', ')}。macOSでは brew install ffmpeg、sshはXcode Command Line Toolsを確認してください。`); }
