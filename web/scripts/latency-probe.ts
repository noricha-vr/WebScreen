#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { analyzeDirectory, loginProfile, runLatencyProbe, switchSource, type RunOptions } from './latency-probe-run';
import { checkWindowsRecording } from './latency-probe-player';

const HELP = `Usage: bun scripts/latency-probe.ts <subcommand> [options]

WebScreen配信を実Mac Chromeから開始し、RTSPT出口と任意のWindowsプレイヤーを時系列計測します。

Subcommands:
  login [--profile-dir PATH]
  player-check [--seconds N] [--out DIR]
  run --minutes N --source URL [--video-profile quality|realtime] [--max-bitrate 1200000|1500000|2000000] [--scroll PX_PER_SECOND] [--outlet-quality-seconds N] [--player win2022] [--profile-dir PATH] [--out DIR] [--notify-discord CHANNEL_ID] [--server-snap HOST]
  source --url URL [--scroll PX_PER_SECOND]
  analyze DIR

run options:
  --minutes N        計測分数（1〜120）
  --source URL       共有タブの遷移先。計測ページを維持するには
                     http://127.0.0.1:0/latency-source.html?tones=1 を指定
  --player win2022   Windows側のベストエフォート録画を有効化
  --profile-dir PATH Chrome永続プロファイル（既定: ~/.webscreen-harness/chrome-profile）
  --out DIR          出力先（既定: docs/tmp/latency/<UTC timestamp>）
  --server-snap HOST 配信サーバーへ SSH し、run 中に ingress / egress のフレームを撮って relay 前後の遅延を server-snap.md に出す
  --video-profile PROFILE quality（既定）または realtime。realtime はproduction画面に設定queryを渡す
  --max-bitrate BPS  realtime 時だけ有効。1200000 / 1500000 / 2000000 のいずれか
  --scroll PX_PER_SECOND 外部共有ページを指定速度で往復スクロール（0〜2000、既定0）
  --outlet-quality-seconds N
                     出口画質の連続ffmpeg測定窓（5〜120秒、既定20）。遅延用の単発取得とは別系統
  --notify-discord CHANNEL_ID
                     配信 URL を Discord の指定チャンネルへ投稿する（VRChat 側の PC で貼るため）

loginはハーネスが開くChromeで一度だけ人がログインするための待機です。player-checkは配信なしでWindows録画だけを試し、実測前に録画経路を確認します。sourceは実行中runの共有タブを切り替えます。analyzeは保存済みCSVからsummary.mdを再生成します。`;

/** CLI契約を検証して実行可能な引数へ変換する。 */
export function parseLatencyProbeArgs(argv: readonly string[]):
  | { command: 'help' }
  | { command: 'run'; options: RunOptions }
  | { command: 'login'; profileDir: string }
  | { command: 'player-check'; seconds: number; outDir: string }
  | { command: 'source'; url: string; scrollPixelsPerSecond: number }
  | { command: 'analyze'; directory: string } {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') return { command: 'help' };
  if (command === 'analyze') {
    if (rest.length !== 1 || rest[0]!.startsWith('-')) throw new Error('analyze requires exactly one directory');
    return { command, directory: rest[0]! };
  }
  const values = parseOptions(rest);
  if (command === 'player-check') {
    rejectUnknown(values, ['seconds', 'out']);
    const seconds = values.seconds === undefined ? 15 : Number(values.seconds);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 300) throw new Error('--seconds must be an integer between 5 and 300');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return { command, seconds, outDir: values.out ?? resolve('..', 'docs', 'tmp', 'latency', `player-check-${stamp}`) };
  }
  if (command === 'login') {
    rejectUnknown(values, ['profile-dir']);
    return { command, profileDir: values['profile-dir'] ?? join(homedir(), '.webscreen-harness', 'chrome-profile') };
  }
  if (command === 'source') {
    rejectUnknown(values, ['url', 'scroll']);
    return { command, url: requiredUrl(values.url, '--url'), scrollPixelsPerSecond: parseScroll(values.scroll) };
  }
  if (command !== 'run') throw new Error(`unknown subcommand: ${command}`);
  rejectUnknown(values, ['minutes', 'source', 'player', 'profile-dir', 'out', 'notify-discord', 'server-snap', 'video-profile', 'max-bitrate', 'scroll', 'outlet-quality-seconds']);
  if (values['server-snap'] !== undefined && !isValidSshHost(values['server-snap'])) throw new Error('--server-snap must be an ssh host name');
  if (values['notify-discord'] !== undefined && !/^\d{15,25}$/.test(values['notify-discord'])) throw new Error('--notify-discord must be a Discord channel id');
  const minutes = Number(values.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw new Error('--minutes must be an integer between 1 and 120');
  if (values.player !== undefined && values.player !== 'win2022') throw new Error('--player must be win2022');
  const videoProfile = values['video-profile'] ?? 'quality';
  if (videoProfile !== 'quality' && videoProfile !== 'realtime') throw new Error('--video-profile must be quality or realtime');
  if (videoProfile === 'quality' && values['max-bitrate'] !== undefined) throw new Error('--max-bitrate is only valid with --video-profile realtime');
  const maxBitrate = values['max-bitrate'] === undefined ? (videoProfile === 'realtime' ? 1_500_000 : null) : Number(values['max-bitrate']);
  if (maxBitrate !== null && ![1_200_000, 1_500_000, 2_000_000].includes(maxBitrate)) throw new Error('--max-bitrate must be 1200000, 1500000, or 2000000');
  const outletQualitySeconds = values['outlet-quality-seconds'] === undefined ? 20 : Number(values['outlet-quality-seconds']);
  if (!Number.isInteger(outletQualitySeconds) || outletQualitySeconds < 5 || outletQualitySeconds > 120) throw new Error('--outlet-quality-seconds must be an integer between 5 and 120');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    command, options: {
      minutes, source: requiredUrl(values.source, '--source'), player: values.player === 'win2022' ? 'win2022' : null,
      videoProfile, maxBitrate, scrollPixelsPerSecond: parseScroll(values.scroll), outletQualitySeconds,
      profileDir: values['profile-dir'] ?? join(homedir(), '.webscreen-harness', 'chrome-profile'),
      notifyDiscordChannelId: values['notify-discord'] ?? null,
      serverSnapHost: values['server-snap'] ?? null,
      outDir: values.out ?? resolve('..', 'docs', 'tmp', 'latency', timestamp),
    },
  };
}

/** SSHホスト名をlabelごとに検証し、オプションとして解釈される値を拒否する。 */
export function isValidSshHost(value: string): boolean {
  return value.length <= 253 && value.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

async function main(): Promise<void> {
  try {
    const parsed = parseLatencyProbeArgs(process.argv.slice(2));
    if (parsed.command === 'help') {
      console.log(HELP);
    } else if (parsed.command === 'run') {
      await mkdir(parsed.options.outDir, { recursive: true });
      console.log(`出力先: ${parsed.options.outDir}`);
      await runLatencyProbe(parsed.options);
    } else if (parsed.command === 'player-check') {
      await mkdir(parsed.outDir, { recursive: true });
      const check = await checkWindowsRecording(parsed.outDir, parsed.seconds);
      console.log(`Windows録画チェック: ${check.ok ? 'OK' : 'NG'} 録画長=${check.durationSeconds ?? '-'}秒（指定 ${parsed.seconds} 秒） 出力=${parsed.outDir}`);
      if (check.warning) console.log(check.warning);
      if (!check.ok) { console.log(check.diagnostics.slice(0, 4000)); process.exitCode = 1; }
    } else if (parsed.command === 'login') {
      await loginProfile(parsed.profileDir);
    } else if (parsed.command === 'source') {
      await switchSource(parsed.url, parsed.scrollPixelsPerSecond);
    } else {
      await analyzeDirectory(parsed.directory);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function parseOptions(argv: readonly string[]): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split('=', 2);
    const value = inline ?? argv[++index];
    if (!name || !value || value.startsWith('--')) throw new Error(`${token} requires a value`);
    if (values[name] !== undefined) throw new Error(`duplicate option: --${name}`);
    values[name] = value;
  }
  return values;
}

function rejectUnknown(values: Record<string, string | undefined>, names: readonly string[]): void {
  for (const name of Object.keys(values)) if (!names.includes(name)) throw new Error(`unknown option: --${name}`);
}

function requiredUrl(value: string | undefined, option: string): string {
  if (!value) throw new Error(`${option} is required`);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${option} must be an absolute URL`); }
  // 共有タブに file: / data: 等を表示させない。資格情報付き URL も配信映像へ漏れるため拒否する
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`${option} must use http or https`);
  if (parsed.username || parsed.password) throw new Error(`${option} must not contain credentials`);
  return parsed.href;
}

function parseScroll(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 2_000) throw new Error('--scroll must be an integer between 0 and 2000');
  return parsed;
}

if (import.meta.main) await main();
