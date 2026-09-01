#!/usr/bin/env bun
import { mkdtemp, rm } from 'node:fs/promises';
import { arch as osArch, platform as osPlatform, release as osRelease, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS,
  SCREEN_SHARE_VIDEO_SETTINGS,
} from '../src/lib/ui/whip-publisher';
import {
  installControllerPage,
  installSourcePage,
  SOURCE_TITLE,
} from './benchmark-screen-share-fps-browser';
import {
  createCleanupStack,
  createSignalHandler,
  parseArgs,
  type BenchmarkOptions,
} from './benchmark-screen-share-fps-core';
import {
  type BrowserRunRaw,
  type BenchmarkRunResult,
  finalizeRun,
  withRunDeadline,
} from './benchmark-screen-share-fps-run';

const PRODUCTION_URL = 'https://web-screen.net/ja/screen-share/?stream-profile=mp3-beta';
const CAPTURE_TIMEOUT_MS = 15_000;
const HELP = `Usage: bun scripts/benchmark-screen-share-fps.ts [options]
実Macのsystem Chromeで別タブ共有を取得し、指定順にfpsを計測します。
Options:
  --mode <tab|screen>   共有対象 (default: tab; screen is unverified)
  --duration <seconds>  各fpsの計測秒数 (default: 10, range: 1-900)
  --fps <list>          カンマ区切りの順序を維持 (default: 24,30; range: 1-120)
  --source <substring>  screen modeで自動選択する画面名の部分文字列
  --help                この説明だけを表示して終了
Environment:
  SCREEN_CAPTURE_SOURCE  --sourceと同じ。CLI指定を優先
画面内容、source名、window title、screenshot、videoは保存・出力しません。`;

function startControllerServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('<!doctype html><meta charset="utf-8"><title>controller</title>', {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      },
    }),
  });
}

async function runOne(
  controllerPage: import('@playwright/test').Page,
  sourcePage: import('@playwright/test').Page,
  fps: number,
  options: BenchmarkOptions
): Promise<BenchmarkRunResult> {
  await controllerPage.bringToFront();
  await controllerPage.evaluate(({ requestedFps, durationSeconds }) => {
    const button = document.querySelector<HTMLButtonElement>('#start')!;
    button.dataset.fps = String(requestedFps);
    button.dataset.duration = String(durationSeconds);
  }, { requestedFps: fps, durationSeconds: options.durationSeconds });
  await controllerPage.click('#start', { timeout: CAPTURE_TIMEOUT_MS });
  if (options.mode === 'screen') await sourcePage.bringToFront();
  const raw = await withRunDeadline(controllerPage.evaluate(() => {
    const benchmarkWindow = window as typeof window & {
      __webscreenFpsBenchmark: { runPromise: Promise<BrowserRunRaw> | null };
    };
    if (!benchmarkWindow.__webscreenFpsBenchmark.runPromise) throw new Error('run did not start');
    return benchmarkWindow.__webscreenFpsBenchmark.runPromise;
  }), options.durationSeconds);
  return finalizeRun(raw, SCREEN_SHARE_VIDEO_SETTINGS);
}

async function runBenchmark(options: BenchmarkOptions): Promise<Record<string, unknown>> {
  const { chromium } = await import('@playwright/test');
  const cleanup = createCleanupStack();
  const signalHandler = createSignalHandler(
    () => cleanup.run(),
    (code) => process.exit(code),
    (error) => console.error(`benchmark cleanup failed: ${String(error)}`)
  );
  const onInterrupt = (): void => { void signalHandler('SIGINT'); };
  const onTerminate = (): void => { void signalHandler('SIGTERM'); };
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    const server = startControllerServer();
    cleanup.add(() => server.stop(true));
    const profileDirectory = await mkdtemp(join(tmpdir(), 'webscreen-fps-benchmark-'));
    cleanup.add(() => rm(profileDirectory, { recursive: true, force: true }));
    const selectionFlag = options.mode === 'tab'
      ? `--auto-select-tab-capture-source-by-title=${SOURCE_TITLE}`
      : options.source ? `--auto-select-desktop-capture-source=${options.source}`
        : '--auto-select-screen-capture-source';
    const context = await chromium.launchPersistentContext(profileDirectory, {
      channel: 'chrome', headless: false, viewport: null,
      args: [selectionFlag, '--start-maximized', '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'],
    });
    cleanup.add(() => context.close());
    const controllerPage = context.pages()[0] ?? await context.newPage();
    await controllerPage.goto(server.url.href, { waitUntil: 'domcontentloaded' });
    await installControllerPage(controllerPage, options.mode);
    const sourcePage = await context.newPage();
    await sourcePage.goto(PRODUCTION_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await installSourcePage(sourcePage);
    const results: BenchmarkRunResult[] = [];
    for (const fps of options.fps) results.push(await runOne(controllerPage, sourcePage, fps, options));
    const userAgent = await controllerPage.evaluate(() => navigator.userAgent);
    return {
      benchmark: 'WebScreen actual Mac screen-share FPS',
      captureMode: options.mode,
      captureModeValidation: options.mode === 'screen' ? 'unverified' : 'actual-mac-other-tab',
      requestedFpsOrder: options.fps,
      chromeVersion: context.browser()?.version() ?? userAgent.match(/Chrome\/([0-9.]+)/)?.[1] ?? 'unknown',
      operatingSystem: { platform: osPlatform(), architecture: osArch(), release: osRelease() },
      encoder: { ...SCREEN_SHARE_VIDEO_SETTINGS,
        keyframeRequestIntervalMs: MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS },
      results,
    };
  } finally {
    try { await cleanup.run(); } finally {
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
    }
  }
}

async function main(): Promise<void> {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log(HELP); return; }
    console.log(JSON.stringify(await runBenchmark(options), null, 2));
  } catch (error) {
    console.error(`benchmark-screen-share-fps: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
