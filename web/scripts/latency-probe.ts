#!/usr/bin/env bun
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { analyzeDirectory, loginProfile, runLatencyProbe, switchSource, type RunOptions } from './latency-probe-run';

const HELP = `Usage: bun scripts/latency-probe.ts <subcommand> [options]

WebScreen配信を実Mac Chromeから開始し、RTSPT出口と任意のWindowsプレイヤーを時系列計測します。

Subcommands:
  login [--profile-dir PATH]
  run --minutes N --source URL [--player win2022] [--profile-dir PATH] [--out DIR]
  source --url URL
  analyze DIR

run options:
  --minutes N        計測分数（1〜120）
  --source URL       共有タブの遷移先。計測ページを維持するには
                     http://127.0.0.1:0/latency-source.html?tones=1 を指定
  --player win2022   Windows側のベストエフォート録画を有効化
  --profile-dir PATH Chrome永続プロファイル（既定: ~/.webscreen-harness/chrome-profile）
  --out DIR          出力先（既定: docs/tmp/latency/<UTC timestamp>）

loginはハーネスが開くChromeで一度だけ人がログインするための待機です。sourceは実行中runの共有タブを切り替えます。analyzeは保存済みCSVからsummary.mdを再生成します。`;

/** CLI契約を検証して実行可能な引数へ変換する。 */
export function parseLatencyProbeArgs(argv: readonly string[]):
  | { command: 'help' }
  | { command: 'run'; options: RunOptions }
  | { command: 'login'; profileDir: string }
  | { command: 'source'; url: string }
  | { command: 'analyze'; directory: string } {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') return { command: 'help' };
  if (command === 'analyze') {
    if (rest.length !== 1 || rest[0]!.startsWith('-')) throw new Error('analyze requires exactly one directory');
    return { command, directory: rest[0]! };
  }
  const values = parseOptions(rest);
  if (command === 'login') {
    rejectUnknown(values, ['profile-dir']);
    return { command, profileDir: values['profile-dir'] ?? join(homedir(), '.webscreen-harness', 'chrome-profile') };
  }
  if (command === 'source') {
    rejectUnknown(values, ['url']);
    return { command, url: requiredUrl(values.url, '--url') };
  }
  if (command !== 'run') throw new Error(`unknown subcommand: ${command}`);
  rejectUnknown(values, ['minutes', 'source', 'player', 'profile-dir', 'out']);
  const minutes = Number(values.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) throw new Error('--minutes must be an integer between 1 and 120');
  if (values.player !== undefined && values.player !== 'win2022') throw new Error('--player must be win2022');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    command, options: {
      minutes, source: requiredUrl(values.source, '--source'), player: values.player === 'win2022' ? 'win2022' : null,
      profileDir: values['profile-dir'] ?? join(homedir(), '.webscreen-harness', 'chrome-profile'),
      outDir: values.out ?? resolve('..', 'docs', 'tmp', 'latency', timestamp),
    },
  };
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
    } else if (parsed.command === 'login') {
      await loginProfile(parsed.profileDir);
    } else if (parsed.command === 'source') {
      await switchSource(parsed.url);
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
  try { return new URL(value).href; } catch { throw new Error(`${option} must be an absolute URL`); }
}

if (import.meta.main) await main();
