import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { formatProfileSwitchesCsv, type ProfileSwitch } from './latency-probe-profile-analysis';

interface PagePeerConnectionWindow extends Window {
  __webscreenHarnessPeerConnections?: RTCPeerConnection[];
}

interface ProfileEvaluationArguments {
  selectedProfile: ProfileSwitch['profile'];
  selectedMaxBitrate: number;
}

interface ProfileEvaluationResult { appliedAtMs: number; senderIdentity: string }

/** Playwright に依存しない、ページ関数を実行するための境界。 */
export interface VideoProfileEvaluator {
  evaluate<TArgument, TResult>(pageFunction: (argument: TArgument) => Promise<TResult>, argument: TArgument): Promise<TResult>;
}

/** 時刻と待機を注入し、プロファイル周期を実Chromeなしで検証可能にする。 */
export interface ProfileCycleClock { now(): number; sleep(milliseconds: number): Promise<void> }

const VALID_MAX_BITRATES = [1_200_000, 1_500_000, 2_000_000] as const;
const IDENTITY_POLL_MS = 5_000;
const defaultClock: ProfileCycleClock = { now: () => Date.now(), sleep: (milliseconds) => Bun.sleep(milliseconds) };

/** Playwright Pageをプロファイル変更用の最小境界へ変換する。 */
export function videoProfileEvaluator(page: import('@playwright/test').Page): VideoProfileEvaluator {
  return {
    evaluate: async <TArgument, TResult>(pageFunction: (argument: TArgument) => Promise<TResult>, argument: TArgument): Promise<TResult> => {
      return await page.evaluate(pageFunction as never, argument as never) as TResult;
    },
  };
}

/** profileとmaxBitrateを外部境界でfail-fastに検証する。 */
export function validateVideoProfile(profile: unknown, maxBitrate: unknown): asserts profile is ProfileSwitch['profile'] {
  if (profile !== 'quality' && profile !== 'realtime') throw new Error('video profile must be quality or realtime');
  if (!VALID_MAX_BITRATES.includes(maxBitrate as typeof VALID_MAX_BITRATES[number])) throw new Error('maxBitrate must be 1200000, 1500000, or 2000000');
}

/** A/B切替周期を外部境界でfail-fastに検証する。 */
export function validateProfileCycleSeconds(cycleSeconds: unknown): asserts cycleSeconds is number {
  if (!Number.isInteger(cycleSeconds) || (cycleSeconds as number) < 60 || (cycleSeconds as number) > 600) throw new Error('cycleSeconds must be an integer between 60 and 600');
}

/** senderへ映像プロファイルを反映し、読み戻した値が一致しなければ失敗する。 */
export async function applyVideoProfile(evaluate: VideoProfileEvaluator, profile: ProfileSwitch['profile'], maxBitrate: number, startedAtMs: number): Promise<ProfileSwitch> {
  validateVideoProfile(profile, maxBitrate);
  const applied = await evaluate.evaluate(async ({ selectedProfile, selectedMaxBitrate }) => {
    // evaluate は外部呼び出し以外からも使われるため、ページ側でも同じ許可集合を検証する。
    if ((selectedProfile !== 'quality' && selectedProfile !== 'realtime') || ![1_200_000, 1_500_000, 2_000_000].includes(selectedMaxBitrate)) throw new Error('invalid video profile evaluation arguments');
    const tracked = window as PagePeerConnectionWindow;
    const connections = (tracked.__webscreenHarnessPeerConnections ?? []).filter((connection) => connection.connectionState !== 'closed');
    tracked.__webscreenHarnessPeerConnections = connections;
    let sender: RTCRtpSender | undefined;
    let connectionIndex = -1;
    for (let index = connections.length - 1; index >= 0 && !sender; index -= 1) {
      sender = connections[index]!.getSenders().find((candidate) => candidate.track?.kind === 'video' && candidate.track.readyState === 'live');
      if (sender) connectionIndex = index;
    }
    if (!sender?.track) throw new Error('video RTCRtpSender was not found for profile switch');
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    const encoding = parameters.encodings[0]!;
    const expectedScale = selectedProfile === 'quality' ? 1 : undefined;
    encoding.maxBitrate = selectedProfile === 'quality' ? 1_200_000 : selectedMaxBitrate;
    if (expectedScale === undefined) delete encoding.scaleResolutionDownBy;
    else encoding.scaleResolutionDownBy = expectedScale;
    parameters.degradationPreference = selectedProfile === 'quality' ? 'maintain-resolution' : 'maintain-framerate';
    await sender.setParameters(parameters);
    sender.track.contentHint = selectedProfile === 'quality' ? 'detail' : 'motion';
    const actual = sender.getParameters();
    const actualEncoding = actual.encodings?.[0];
    const expectedBitrate = selectedProfile === 'quality' ? 1_200_000 : selectedMaxBitrate;
    const expectedDegradation = selectedProfile === 'quality' ? 'maintain-resolution' : 'maintain-framerate';
    const expectedHint = selectedProfile === 'quality' ? 'detail' : 'motion';
    if (actualEncoding?.maxBitrate !== expectedBitrate || actualEncoding.scaleResolutionDownBy !== expectedScale || actual.degradationPreference !== expectedDegradation || sender.track.contentHint !== expectedHint) throw new Error(`profile switch readback mismatch: expected ${selectedProfile}`);
    return { appliedAtMs: Date.now(), senderIdentity: `${connectionIndex}:${sender.track.id}` };
  }, { selectedProfile: profile, selectedMaxBitrate: maxBitrate });
  return { observedAtMs: applied.appliedAtMs, elapsedSeconds: (applied.appliedAtMs - startedAtMs) / 1_000, profile, maxBitrate: profile === 'quality' ? 1_200_000 : maxBitrate, action: 'applied', senderIdentity: applied.senderIdentity };
}

/** 初期プロファイルを反映・検証して切替CSVの先頭行へ保存する。 */
export async function startVideoProfileCycle(evaluate: VideoProfileEvaluator, outDir: string, startedAtMs: number, initialProfile: ProfileSwitch['profile'], realtimeMaxBitrate: number): Promise<ProfileSwitch> {
  const initial = await applyVideoProfile(evaluate, initialProfile, realtimeMaxBitrate, startedAtMs);
  await writeFile(join(outDir, 'profile-switches.csv'), formatProfileSwitchesCsv([initial]));
  return initial;
}

/** 指定間隔で切替え、sender差し替え時は同プロファイルを再適用してCSVへ記録する。 */
export async function cycleVideoProfiles(evaluate: VideoProfileEvaluator, outDir: string, startedAtMs: number, until: number, initial: ProfileSwitch, realtimeMaxBitrate: number, cycleSeconds: number, signal?: AbortSignal, clock: ProfileCycleClock = defaultClock): Promise<ProfileSwitch[]> {
  validateVideoProfile(initial.profile, realtimeMaxBitrate);
  validateProfileCycleSeconds(cycleSeconds);
  const switches = [initial];
  const outputPath = join(outDir, 'profile-switches.csv');
  let activeProfile = initial.profile;
  let activeIdentity = initial.senderIdentity;
  let nextSwitchAtMs = startedAtMs + cycleSeconds * 1_000;
  let nextIdentityPollAtMs = startedAtMs + IDENTITY_POLL_MS;
  while (!signal?.aborted && clock.now() < until) {
    const now = clock.now();
    const nextEventAtMs = Math.min(nextSwitchAtMs, nextIdentityPollAtMs, until);
    if (now < nextEventAtMs) { await clock.sleep(nextEventAtMs - now); continue; }
    if (signal?.aborted || clock.now() >= until) break;
    if (now >= nextIdentityPollAtMs) {
      const identity = await readLiveVideoSenderIdentity(evaluate);
      if (signal?.aborted || clock.now() >= until) break;
      if (activeIdentity !== undefined && identity !== activeIdentity) {
        const reapplied = await applyVideoProfile(evaluate, activeProfile, realtimeMaxBitrate, startedAtMs);
        reapplied.action = 'reapplied';
        ensureChronological(reapplied, switches.at(-1)!, startedAtMs);
        switches.push(reapplied);
        activeIdentity = reapplied.senderIdentity;
        await appendProfileSwitch(outputPath, reapplied);
      } else activeIdentity = identity;
      while (nextIdentityPollAtMs <= now) nextIdentityPollAtMs += IDENTITY_POLL_MS;
    }
    if (now >= nextSwitchAtMs) {
      if (signal?.aborted || clock.now() >= until) break;
      activeProfile = activeProfile === 'quality' ? 'realtime' : 'quality';
      const switched = await applyVideoProfile(evaluate, activeProfile, realtimeMaxBitrate, startedAtMs);
      ensureChronological(switched, switches.at(-1)!, startedAtMs);
      switches.push(switched);
      activeIdentity = switched.senderIdentity;
      await appendProfileSwitch(outputPath, switched);
      while (nextSwitchAtMs <= now) nextSwitchAtMs += cycleSeconds * 1_000;
    }
  }
  return switches;
}

async function readLiveVideoSenderIdentity(evaluate: VideoProfileEvaluator): Promise<string> {
  return evaluate.evaluate(async () => {
    const tracked = window as PagePeerConnectionWindow;
    const connections = (tracked.__webscreenHarnessPeerConnections ?? []).filter((connection) => connection.connectionState !== 'closed');
    tracked.__webscreenHarnessPeerConnections = connections;
    for (let index = connections.length - 1; index >= 0; index -= 1) {
      const sender = connections[index]!.getSenders().find((candidate) => candidate.track?.kind === 'video' && candidate.track.readyState === 'live');
      if (sender?.track) return `${index}:${sender.track.id}`;
    }
    throw new Error('video RTCRtpSender was not found while checking profile identity');
  }, undefined);
}

async function appendProfileSwitch(outputPath: string, profileSwitch: ProfileSwitch): Promise<void> {
  await appendFile(outputPath, formatProfileSwitchesCsv([profileSwitch]).split('\n').slice(1).join('\n'));
}

function ensureChronological(next: ProfileSwitch, previous: ProfileSwitch, startedAtMs: number): void {
  // 同一ミリ秒に再適用と定刻切替が重なるとCSVの順序が失われるため、記録時だけ最小単位で並べる。
  if (next.observedAtMs <= previous.observedAtMs) {
    next.observedAtMs = previous.observedAtMs + 1;
    next.elapsedSeconds = (next.observedAtMs - startedAtMs) / 1_000;
  }
}
