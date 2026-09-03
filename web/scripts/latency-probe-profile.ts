import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { formatProfileSwitchesCsv, type ProfileSwitch } from './latency-probe-profile-analysis';

interface PagePeerConnectionWindow extends Window {
  __webscreenHarnessPeerConnections?: RTCPeerConnection[];
}

/** senderへ映像プロファイルを反映し、読み戻した値が一致しなければ失敗する。 */
export async function applyVideoProfile(page: import('@playwright/test').Page, profile: ProfileSwitch['profile'], maxBitrate: number, startedAtMs: number): Promise<ProfileSwitch> {
  const appliedAtMs = await page.evaluate(async ({ selectedProfile, selectedMaxBitrate }) => {
    const tracked = window as PagePeerConnectionWindow;
    const connections = (tracked.__webscreenHarnessPeerConnections ?? []).filter((connection) => connection.connectionState !== 'closed');
    tracked.__webscreenHarnessPeerConnections = connections;
    // 自動再接続済みでも既存のcaptureSenderConfigと同じ、最新のlive video senderだけを変更する。
    const connection = connections.toReversed().find((candidate) => candidate.getSenders().some((sender) => sender.track?.kind === 'video' && sender.track.readyState === 'live'));
    const sender = connection?.getSenders().find((candidate) => candidate.track?.kind === 'video' && candidate.track.readyState === 'live');
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
    return Date.now();
  }, { selectedProfile: profile, selectedMaxBitrate: maxBitrate });
  return { observedAtMs: appliedAtMs, elapsedSeconds: (appliedAtMs - startedAtMs) / 1_000, profile, maxBitrate: profile === 'quality' ? 1_200_000 : maxBitrate };
}

/** 初期プロファイルを反映・検証して切替CSVの先頭行へ保存する。 */
export async function startVideoProfileCycle(page: import('@playwright/test').Page, outDir: string, startedAtMs: number, initialProfile: ProfileSwitch['profile'], realtimeMaxBitrate: number): Promise<ProfileSwitch> {
  const initial = await applyVideoProfile(page, initialProfile, realtimeMaxBitrate, startedAtMs);
  await writeFile(join(outDir, 'profile-switches.csv'), formatProfileSwitchesCsv([initial]));
  return initial;
}

/** 指定間隔でquality/realtimeを交互に切り替え、各成功をCSVへ追記する。 */
export async function cycleVideoProfiles(page: import('@playwright/test').Page, outDir: string, startedAtMs: number, until: number, initial: ProfileSwitch, realtimeMaxBitrate: number, cycleSeconds: number, signal?: AbortSignal): Promise<ProfileSwitch[]> {
  const switches = [initial];
  const outputPath = join(outDir, 'profile-switches.csv');
  let activeProfile = initial.profile;
  let nextSwitchAtMs = startedAtMs + cycleSeconds * 1_000;
  while (nextSwitchAtMs < until && !signal?.aborted) {
    while (Date.now() < nextSwitchAtMs && !signal?.aborted) await Bun.sleep(Math.min(1_000, nextSwitchAtMs - Date.now()));
    if (signal?.aborted || Date.now() >= until) break;
    activeProfile = activeProfile === 'quality' ? 'realtime' : 'quality';
    const switched = await applyVideoProfile(page, activeProfile, realtimeMaxBitrate, startedAtMs);
    switches.push(switched);
    await appendFile(outputPath, formatProfileSwitchesCsv([switched]).split('\n').slice(1).join('\n'));
    nextSwitchAtMs += cycleSeconds * 1_000;
  }
  return switches;
}
