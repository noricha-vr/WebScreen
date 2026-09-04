import { homedir } from 'node:os';
import { captureServerSnapshots, snapshotScheduleSeconds } from './latency-probe-server-snap';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { formatLatencyCsv, formatSummary, type LatencySample } from './latency-probe-analysis';
import {
  analyzeSavedOutletAudio, audioSamplesFromCapture, collectAudio, collectVideo, persistOutletArtifacts,
  collectOutletGrabs, decodeDurationSummary, probeDimensionsFor, readPipeText, requirePipe, scaledProbeDimensions, startAudioProbe, type VideoDiagnostics,
} from './latency-probe-observe';
import { recordWindowsPlayer, type PlayerResult } from './latency-probe-player';
import { captureSenderConfig, collectOutletQuality, collectSenderStats, parseSenderCsv, peerConnectionTrackerInitScript } from './latency-probe-quality';
import { cycleVideoProfiles, startVideoProfileCycle, validateProfileCycleSeconds, validateVideoProfile, videoProfileEvaluator } from './latency-probe-profile';
import type { ProfileSwitch } from './latency-probe-profile-analysis';
import { screenShareUrl, stopSharingBeforeClose } from './latency-probe-screen-share';

export { screenShareUrl } from './latency-probe-screen-share';

const SOURCE_TITLE = 'WebScreen Latency Source';
const ACTIVE_FILE = resolve('..', 'docs', 'tmp', 'latency', '.active.json');
const SOURCE_FILE = Bun.file(new URL('./latency-source.html', import.meta.url));
const PREVIOUS_RUN_ARTIFACTS = [
  'cleanup-error.md', 'outlet-audio.csv', 'outlet-audio.json', 'outlet-audio.wav', 'outlet-decode.log', 'outlet-ffmpeg.log',
  'outlet-quality.csv', 'outlet-quality.log', 'outlet-quality.md', 'outlet.csv', 'player-error.md', 'player-recording.md',
  'player.csv', 'profile-switches.csv', 'recording.mp4', 'sender-config.json', 'sender-error.md', 'sender.csv', 'server-snap.md',
  'server-snap', 'summary.md', 'frames',
] as const;

/** 実行時に固定する遅延ハーネスの引数。 */
export interface RunOptions {
  minutes: number; source: string; player: 'win2022' | null; profileDir: string; outDir: string; videoProfile: 'quality' | 'realtime'; maxBitrate: number | null;
  abCycleSeconds: number | null; scrollPixelsPerSecond: number; outletQualitySeconds: number; notifyDiscordChannelId: string | null; serverSnapHost: string | null; streamId: string | null;
  /** 配信先ノードのホスト名。null なら本番既定（API 応答の whipUrl と webscreen.tv）を使う。 */
  nodeHost: string | null;
  /** 視聴先だけを差し替える `host` または `host:port`。null なら nodeHost、それも null なら webscreen.tv。 */
  readHost: string | null;
}
interface ActiveController { endpoint: string; sourceUrl: string }
interface ControllerState { sourcePage: import('@playwright/test').Page | null; sourceUrl: string; sourceServerUrl: string }

const browserLog: string[] = [];
function pushBrowserLog(line: string): void { browserLog.push(`${new Date().toISOString()} ${line}`); if (browserLog.length > 80) browserLog.shift(); }
function browserLogTail(): string { return browserLog.length ? `\nbrowser console:\n${browserLog.slice(-30).join('\n')}` : ''; }

/** 実Chromeの画面共有、出口プローブ、出力保存を同じcleanup境界で実行する。 */
export async function runLatencyProbe(options: RunOptions): Promise<void> {
  validateRunOptions(options);
  rejectRepositoryProfile(options.profileDir);
  requireCommands(options.player);
  await mkdir(options.outDir, { recursive: true, mode: 0o700 });
  await chmod(options.outDir, 0o700);
  await clearPreviousRunArtifacts(options.outDir);
  const sourceServer = startSourceServer();
  const state: ControllerState = { sourcePage: null, sourceUrl: sourceServer.url.href, sourceServerUrl: sourceServer.url.href };
  const controllerServer = startControllerServer(state);
  await mkdir(resolve('..', 'docs', 'tmp', 'latency'), { recursive: true });
  await writeFile(ACTIVE_FILE, JSON.stringify({ endpoint: controllerServer.url.href, sourceUrl: sourceServer.url.href }));
  let startedAtMs = 0;
  const outlet: LatencySample[] = [];
  let browser: import('@playwright/test').BrowserContext | null = null;
  let audio: Bun.Subprocess | null = null;
  let senderPump: Promise<Awaited<ReturnType<typeof collectSenderStats>>> | null = null;
  let outletQualityPump: Promise<void> | null = null;
  let profileSwitchPump: Promise<ProfileSwitch[]> | null = null;
  const measurementAbort = new AbortController();
  try {
    browser = await startChrome(options.profileDir);
    const sourcePage = browser.pages()[0] ?? await browser.newPage();
    state.sourcePage = sourcePage;
    await sourcePage.goto(sourceServer.url.href, { waitUntil: 'domcontentloaded' });
    const sharingPage = await browser.newPage();
    // 共有ページだけに限定する（context 全体に掛けると計測対象外のページの RTCPeerConnection まで置換される）
    await sharingPage.addInitScript(peerConnectionTrackerInitScript());
    attachBrowserLog(sharingPage);
    if (options.nodeHost) await routeWhipToNode(sharingPage, options.nodeHost);
    await sharingPage.goto(screenShareUrl(options), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const streamId = await startScreenShare(sharingPage, options.profileDir);
    const readHost = options.readHost ?? options.nodeHost ?? 'webscreen.tv';
    await writeFile(join(options.outDir, 'sender-config.json'), JSON.stringify({ ...await captureSenderConfig(sharingPage), harnessNodeHost: options.nodeHost, harnessReadHost: readHost }, null, 2) + '\n');
    const target = resolveSourceUrl(options.source, sourceServer.url);
    if (target !== sourceServer.url.href) await sourcePage.goto(target, { waitUntil: 'domcontentloaded' });
    await applyAutoScroll(sourcePage, target, sourceServer.url.href, options.scrollPixelsPerSecond);
    await sourcePage.bringToFront();
    const rtspUrl = `rtsp://${readHost}/live/${streamId}`;
    // VRChat へ貼る URL を人に渡す経路（クリップボードと固定ファイル）。run はこの後ブロックするため、
    // 標準出力だけだと貼るタイミングで URL を伝えられない
    const viewerUrl = `rtspt://${readHost}/live/${streamId}`;
    console.info(`配信 URL: ${viewerUrl}`);
    await writeFile(join(options.profileDir, 'current-stream-url.txt'), `${viewerUrl}\n`).catch(() => undefined);
    if (process.platform === 'darwin') {
      const pbcopy = Bun.spawn(['pbcopy'], { stdin: 'pipe' });
      pbcopy.stdin.write(viewerUrl);
      pbcopy.stdin.end();
      await pbcopy.exited;
    }
    if (options.notifyDiscordChannelId) await notifyDiscord(options.notifyDiscordChannelId, viewerUrl, options.minutes);
    const dimensions = scaledProbeDimensions(await probeDimensionsFor(rtspUrl));
    audio = startAudioProbe(rtspUrl);
    const videoLog = Promise.resolve('(映像は単発取得方式のため連続 ffmpeg なし)');
    const audioLog = readPipeText(requirePipe(audio.stderr, 'audio stderr'));
    state.sourceUrl = target;
    startedAtMs = Date.now();
    const until = startedAtMs + options.minutes * 60_000;
    if (options.abCycleSeconds !== null) {
      if (options.maxBitrate === null) throw new Error('--ab-cycle requires --max-bitrate for realtime intervals');
      // 初期プロファイルの反映・読み戻しに失敗した場合は、出口計測を始めずにrunを失敗させる。
      const evaluator = videoProfileEvaluator(sharingPage);
      const initialProfileSwitch = await startVideoProfileCycle(evaluator, options.outDir, startedAtMs, options.videoProfile, options.maxBitrate);
      profileSwitchPump = cycleVideoProfiles(evaluator, options.outDir, startedAtMs, until, initialProfileSwitch, options.maxBitrate, options.abCycleSeconds, measurementAbort.signal);
    }
    senderPump = collectSenderStats(sharingPage, options.outDir, until, measurementAbort.signal);
    outletQualityPump = collectOutletQuality(rtspUrl, options.outDir, startedAtMs, until, options.outletQualitySeconds, measurementAbort.signal);
    const diagnostics: VideoDiagnostics = { firstDecoded: null, lastDecoded: null, lastFailure: null, decodeLog: [], lastLoggedFailureAtMs: null, decodeCount: 0, decodeMsTotal: 0, decodeMsMax: 0 };
    const serverSnap = options.serverSnapHost
      ? captureServerSnapshots(options.serverSnapHost, streamId, options.outDir, startedAtMs, snapshotScheduleSeconds(options.minutes)).catch((error) => { console.warn(`サーバー内スナップショットに失敗しました: ${String(error)}`); return []; })
      : Promise.resolve([]);
    const playerPump = options.player ? recordWindowsPlayer(options.outDir, until).catch((error) => ({ samples: [], warning: `Windows計測は失敗しました: ${String(error)}`, diagnostics: String(error) } satisfies PlayerResult)) : Promise.resolve(null);
    const [, capturedAudio, player, senderResult, , profileSwitches] = await Promise.all([
      collectOutletGrabs(rtspUrl, until, outlet, diagnostics, join(options.outDir, 'frames')),
      collectAudio(requirePipe(audio.stdout, 'audio'), until), playerPump, senderPump, outletQualityPump,
      profileSwitchPump ?? Promise.resolve(null),
    ]);
    outlet.push(...audioSamplesFromCapture(capturedAudio, outlet));
    const audioExitBeforeStop = audio.exitCode;
    if (audioExitBeforeStop === null) audio.kill();
    await serverSnap;
    await audio.exited;
    const [videoStderr, audioStderr] = await Promise.all([videoLog, audioLog]);
    diagnostics.decodeLog.push(`${new Date().toISOString()} ${decodeDurationSummary(diagnostics)}`);
    await persistOutletArtifacts(options.outDir, startedAtMs, capturedAudio, outlet, dimensions, diagnostics, videoStderr, audioStderr);
    const failures = [
      audioExitBeforeStop !== null && audioExitBeforeStop !== 0 ? `audio ffmpeg exit=${audioExitBeforeStop}\n${audioStderr}` : null,
    ].filter((failure): failure is string => failure !== null);
    if (failures.length) throw new Error(`出口ffmpegが計測終了前に失敗しました。outlet-ffmpeg.logを保存しました。\n${failures.join('\n')}`);
    await persistResults(options.outDir, outlet, startedAtMs, player, senderResult.samples, profileSwitches);
  } finally {
    measurementAbort.abort();
    // 各pumpはfinallyでCSVを書き出すため、出力先のcleanup前に終了まで回収する。
    await Promise.allSettled([senderPump, outletQualityPump, profileSwitchPump].filter((pump): pump is Exclude<typeof pump, null> => pump !== null));
    audio?.kill();
    // browser.close() だけでは pagehide の停止ビーコンが飛ばず配信がサーバーに残り、次の run が
    // 「既存の配信を終了」経路に入って不安定になる（2026-09-02 実測）。閉じる前に停止ボタンを押す
    if (browser) await stopSharingBeforeClose(browser, options.outDir);
    await Promise.allSettled([
      browser?.close(),
      Promise.resolve().then(() => controllerServer.stop(true)),
      Promise.resolve().then(() => sourceServer.stop(true)),
      rm(ACTIVE_FILE, { force: true }),
    ]);
  }
}

/** ハーネスが起動するChromeに手動ログインし、プロファイルへCookieを残す。 */
export async function loginProfile(profileDir: string, timeoutMs = 8 * 60_000): Promise<void> {
  rejectRepositoryProfile(profileDir);
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  await chmod(profileDir, 0o700);
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
export async function switchSource(url: string, scrollPixelsPerSecond = 0): Promise<void> {
  const active = JSON.parse(await readFile(ACTIVE_FILE, 'utf8')) as ActiveController;
  const response = await fetch(new URL('/source', active.endpoint), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, scrollPixelsPerSecond }) });
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
  const video = outlet.filter((sample) => sample.videoLatencyMs !== null);
  const audio = await analyzeSavedOutletAudio(directory, video);
  if (audio) await writeFile(join(directory, 'outlet-audio.csv'), formatLatencyCsv(audio, startedAtMs));
  const senderPath = join(directory, 'sender.csv');
  const sender = await Bun.file(senderPath).exists() ? parseSenderCsv(await readFile(senderPath, 'utf8')) : null;
  const switchesPath = join(directory, 'profile-switches.csv');
  const { parseProfileSwitchesCsv } = await import('./latency-probe-profile-analysis');
  const profileSwitches = await Bun.file(switchesPath).exists() ? parseProfileSwitchesCsv(await readFile(switchesPath, 'utf8')) : null;
  if (profileSwitches && (!Number.isFinite(startedAtMs) || Math.abs(profileSwitches[0]!.observedAtMs - startedAtMs) > 60_000)) {
    throw new Error('profile-switches.csv initial timestamp must be within 60 seconds of the outlet.csv inferred start time');
  }
  await writeFile(join(directory, 'summary.md'), formatSummary([...video, ...(audio ?? outlet.filter((sample) => sample.audioLatencyMs !== null || sample.audioLatencyPhaseMs !== null))], player, startedAtMs, sender, profileSwitches));
}

/** 前回runの解析対象成果物を消し、`--out` 再利用時の混在を防ぐ。 */
export async function clearPreviousRunArtifacts(outDir: string): Promise<void> {
  await Promise.all(PREVIOUS_RUN_ARTIFACTS.map((artifact) => rm(join(outDir, artifact), { recursive: true, force: true })));
}

/** runの公開境界でプロファイル関連値を検証し、副作用の前に不正入力を拒否する。 */
export function validateRunOptions(options: RunOptions): void {
  if (options.videoProfile !== 'quality' && options.videoProfile !== 'realtime') throw new Error('videoProfile must be quality or realtime');
  if (options.nodeHost !== null) validateNodeHost(options.nodeHost);
  if (options.readHost !== null) validateReadHost(options.readHost);
  if (options.maxBitrate !== null) validateVideoProfile(options.videoProfile, options.maxBitrate);
  if (options.videoProfile === 'realtime' && options.maxBitrate === null) throw new Error('realtime videoProfile requires maxBitrate');
  if (options.abCycleSeconds !== null) {
    validateProfileCycleSeconds(options.abCycleSeconds);
    if (options.maxBitrate === null) throw new Error('--ab-cycle requires --max-bitrate for realtime intervals');
  }
}

/** ハーネスが配信先に選べるノードは自前ドメイン配下だけ（publish JWT を任意ホストへ送らせない）。 */
export const NODE_HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.web-screen\.net$/;

/** 視聴先は nodeHost と同じ allowlist に任意のポート（1〜65535）を許す。 */
export function validateReadHost(readHost: string): void {
  const [host, port, ...rest] = readHost.split(':');
  if (rest.length > 0 || host === undefined) throw new Error('readHost must be host or host:port');
  validateNodeHost(host);
  if (port !== undefined && !/^[1-9][0-9]{0,4}$/.test(port)) throw new Error('readHost port must be an integer');
  if (port !== undefined && Number(port) > 65_535) throw new Error('readHost port must be 1..65535');
}

export function validateNodeHost(nodeHost: string): void {
  if (!NODE_HOST_PATTERN.test(nodeHost)) throw new Error('nodeHost must be a single label under web-screen.net (e.g. chi1.web-screen.net)');
}

/**
 * 配信開始 / 再利用 API の応答に含まれる whipUrl のホストだけを差し替える。
 * パス `/live/{id}/whip` と https は維持するので、画面側の whipUrl 検証（isWhipUrl）はそのまま通る。
 * whipUrl を持たない応答（エラー・停止 API）は触らず返す。
 */
export function rewriteWhipUrlHost(body: string, nodeHost: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return body; }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { whipUrl?: unknown }).whipUrl !== 'string') return body;
  const whip = new URL((parsed as { whipUrl: string }).whipUrl);
  whip.host = nodeHost;
  return JSON.stringify({ ...(parsed as Record<string, unknown>), whipUrl: whip.href });
}

/**
 * 本番 Worker の health は本番 origin（Indigo）の MediaMTX しか見ないため、別ノードへ publish すると
 * 永遠に starting のまま republish → 映像未到達エラーになる。ハーネスでは health を「呼ばれるごとに
 * egress bytes が増える ready」に差し替え、実際の到達確認は出口 ffmpeg（probe / grab）に任せる。
 */
export function syntheticHealthBody(attempt: number): string {
  return JSON.stringify({ state: 'ready', ingressBytes: 1_000 * (attempt + 1), egressBytes: 1_000 * (attempt + 1), audioDetected: null });
}

/** 本文を書き換えた応答用のヘッダー。圧縮・長さ・validator は元の本文のものなので落とす。 */
export function headersForRewrittenBody(headers: Record<string, string>): Record<string, string> {
  const dropped = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'etag', 'last-modified']);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !dropped.has(name.toLowerCase())));
}

/** 本番 Worker と DNS を変えずに、このブラウザの WHIP だけを指定ノードへ向ける（計測専用）。 */
async function routeWhipToNode(page: import('@playwright/test').Page, nodeHost: string): Promise<void> {
  validateNodeHost(nodeHost);
  let healthAttempt = 0;
  await page.route('**/api/streams/**', async (route) => {
    const url = new URL(route.request().url());
    if (/^\/api\/streams\/[A-Za-z0-9]{12}\/health\/?$/.test(url.pathname)) {
      await route.fulfill({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: syntheticHealthBody(healthAttempt) });
      healthAttempt += 1;
      return;
    }
    const response = await route.fetch();
    if (!(response.headers()['content-type'] ?? '').includes('application/json')) { await route.fulfill({ response }); return; }
    const body = await response.text();
    const rewritten = rewriteWhipUrlHost(body, nodeHost);
    if (rewritten === body) { await route.fulfill({ response }); return; }
    await route.fulfill({ status: response.status(), headers: headersForRewrittenBody(response.headers()), body: rewritten });
  });
  pushBrowserLog(`[harness] whipUrl host -> ${nodeHost}（health は合成応答）`);
}

async function persistResults(outDir: string, outlet: LatencySample[], startedAtMs: number, player: PlayerResult | null, sender: Parameters<typeof formatSummary>[3], profileSwitches: Parameters<typeof formatSummary>[4]): Promise<void> {
  await writeFile(join(outDir, 'outlet.csv'), formatLatencyCsv(outlet, startedAtMs));
  if (player) {
    await writeFile(join(outDir, 'player.csv'), formatLatencyCsv(player.samples, startedAtMs));
    await writeFile(join(outDir, 'player-recording.md'), player.diagnostics);
    if (player.warning) await writeFile(join(outDir, 'player-error.md'), `${player.warning}\n\n${player.diagnostics}`);
  }
  const playerWarning = player?.warning ? `\n## プレイヤー側\n\n- ${player.warning}\n` : '';
  await writeFile(join(outDir, 'summary.md'), formatSummary(outlet, player?.samples ?? null, startedAtMs, sender, profileSwitches) + playerWarning);
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
    const body = await request.json().catch(() => null) as { url?: unknown; scrollPixelsPerSecond?: unknown } | null;
    if (!body || typeof body.url !== 'string') return new Response('url is required', { status: 400 });
    const target = resolveSourceUrl(body.url, new URL(state.sourceServerUrl));
    if (!state.sourcePage) return new Response('run is not ready', { status: 409 });
    if (typeof body.scrollPixelsPerSecond !== 'number' || !Number.isInteger(body.scrollPixelsPerSecond) || body.scrollPixelsPerSecond < 0 || body.scrollPixelsPerSecond > 2_000) return new Response('scrollPixelsPerSecond must be an integer between 0 and 2000', { status: 400 });
    await state.sourcePage.goto(target, { waitUntil: 'domcontentloaded' });
    await applyAutoScroll(state.sourcePage, target, state.sourceServerUrl, body.scrollPixelsPerSecond); state.sourceUrl = target;
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
    await page.waitForFunction(() => Boolean(document.querySelector<HTMLInputElement>('[data-screen-url]')?.value) || Boolean(document.querySelector<HTMLElement>('[data-screen-step="login"]') && !document.querySelector<HTMLElement>('[data-screen-step="login"]')?.hidden), undefined, { timeout: 90_000 });
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

function resolveSourceUrl(value: string, sourceServer: URL): string {
  const parsed = new URL(value);
  // controller 経由（/source）でも CLI と同じ制約を掛ける。http(s) 以外と資格情報付きは拒否
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) throw new Error('source url must be http(s) without credentials');
  if (parsed.hostname === '127.0.0.1' && parsed.port === '0') parsed.port = sourceServer.port;
  return parsed.href;
}
async function applyAutoScroll(page: import('@playwright/test').Page, target: string, sourceServerUrl: string, pixelsPerSecond: number): Promise<void> {
  const source = new URL(sourceServerUrl);
  const url = new URL(target);
  if (url.origin === source.origin) return;
  await page.evaluate((speed) => {
    const host = window as Window & { __webscreenHarnessScrollFrame?: number };
    if (host.__webscreenHarnessScrollFrame !== undefined) cancelAnimationFrame(host.__webscreenHarnessScrollFrame);
    if (speed === 0) return;
    let direction = 1, previous = performance.now();
    const tick = (now: number): void => {
      const maximum = Math.max(0, document.documentElement.scrollHeight - innerHeight);
      if (scrollY >= maximum - 0.5) direction = -1;
      if (scrollY <= 0.5) direction = 1;
      scrollTo(0, Math.min(maximum, Math.max(0, scrollY + direction * speed * (now - previous) / 1_000)));
      previous = now; host.__webscreenHarnessScrollFrame = requestAnimationFrame(tick);
    };
    host.__webscreenHarnessScrollFrame = requestAnimationFrame(tick);
  }, pixelsPerSecond);
}
function rejectRepositoryProfile(profileDir: string): void {
  const repository = resolve('..');
  const candidate = resolve(profileDir);
  const path = relative(repository, candidate);
  if (path === '' || (path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !path.startsWith('..'))) throw new Error('--profile-dir must not be inside the repository');
}
function requireCommands(player: RunOptions['player']): void { const required = player ? ['ffmpeg', 'ffprobe', 'ssh'] : ['ffmpeg', 'ffprobe']; const missing = required.filter((command) => Bun.which(command) === null); if (missing.length) throw new Error(`必要なコマンドがありません: ${missing.join(', ')}。macOSでは brew install ffmpeg、sshはXcode Command Line Toolsを確認してください。`); }

const DISCORD_NOTIFY_SCRIPT = `${homedir()}/.claude/skills/discord-mention/scripts/notify-discord.ts`;

/** VRChat を動かす別 PC で URL を拾えるよう、Discord のチャンネルへ配信 URL を投稿する（失敗は計測を止めない）。 */
async function notifyDiscord(channelId: string, viewerUrl: string, minutes: number): Promise<void> {
  const message = `遅延計測の配信を開始しました（${minutes} 分）。VRChat に貼ってください:\n${viewerUrl}`;
  const child = Bun.spawn(['bun', DISCORD_NOTIFY_SCRIPT, '--message', message, '--target', 'nori', '--channel-id', channelId, '--project-dir', process.cwd()], { stdout: 'pipe', stderr: 'pipe' });
  const stderr = await readPipeText(requirePipe(child.stderr, 'discord notify stderr'));
  const exit = await Promise.race([child.exited, Bun.sleep(10_000).then(() => { child.kill(); return -1; })]);
  if (exit !== 0) console.warn(`Discord 通知に失敗またはタイムアウトしました: ${stderr.trim()}`);
  else console.info(`Discord へ配信 URL を投稿しました（channel ${channelId}）`);
}
