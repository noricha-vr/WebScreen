import type { Page } from '@playwright/test';

import {
  MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS,
  SCREEN_SHARE_VIDEO_SETTINGS,
} from '../src/lib/ui/whip-publisher';
import type { BenchmarkOptions, StatsRow } from './benchmark-screen-share-fps-core';
import type { BrowserRunRaw } from './benchmark-screen-share-fps-run';

/** title限定の自動選択で使うcapture source名。 */
export const SOURCE_TITLE = 'WebScreen FPS benchmark source';
const CAPTURE_TIMEOUT_MS = 15_000;
const SAFE_SETTING_KEYS = [
  'width', 'height', 'frameRate', 'aspectRatio', 'displaySurface', 'logicalSurface',
  'cursor', 'resizeMode',
] as const;

/** production secure originへ高コントラストのcapture sourceだけを配置する。 */
export async function installSourcePage(page: Page): Promise<void> {
  await page.evaluate((sourceTitle) => {
    document.title = sourceTitle;
    document.body.innerHTML = '<canvas id="motion"></canvas>';
    const style = document.createElement('style');
    style.textContent = 'html,body,#motion{margin:0;width:100%;height:100%;overflow:hidden;background:#000}';
    document.head.append(style);
    const canvas = document.querySelector<HTMLCanvasElement>('#motion')!;
    const context = canvas.getContext('2d', { alpha: false })!;
    let frame = 0;
    let lastDrawAt = -Infinity;
    function drawMotion(now: number): void {
      requestAnimationFrame(drawMotion);
      if (now - lastDrawAt < 1_000 / 60 - 1) return;
      lastDrawAt = now;
      const ratio = Math.min(devicePixelRatio, 2);
      [canvas.width, canvas.height] = [innerWidth * ratio, innerHeight * ratio];
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.fillStyle = frame % 2 ? '#050505' : '#0057ff';
      context.fillRect(0, 0, innerWidth, innerHeight);
      context.fillStyle = '#fff';
      context.fillRect((frame * 12) % (innerWidth + 160) - 160, 0, 160, innerHeight);
      context.fillStyle = '#ffe600';
      context.font = '700 48px system-ui';
      context.fillText(`FRAME ${frame}`, 32, innerHeight / 2);
      frame += 1;
    }
    requestAnimationFrame(drawMotion);
  }, SOURCE_TITLE);
}

/** localhost secure originへcapture controllerとloopback計測器だけを配置する。 */
export async function installControllerPage(
  page: Page,
  captureMode: BenchmarkOptions['mode']
): Promise<void> {
  const settings = SCREEN_SHARE_VIDEO_SETTINGS;
  await page.evaluate((config) => {
    if (!window.isSecureContext) throw new Error('localhost controller is not a secure context');
    document.title = 'WebScreen FPS benchmark controller';
    document.body.innerHTML = `<video id="preview" muted playsinline></video>
      <video id="receiver" muted playsinline></video><button id="start" type="button">Start capture</button>`;
    const style = document.createElement('style');
    style.textContent = `html,body{margin:0;background:#111}#preview,#receiver{position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:.01}
      #start{position:fixed;left:16px;top:16px}`;
    document.head.append(style);
    const preview = document.querySelector<HTMLVideoElement>('#preview')!;
    const receiver = document.querySelector<HTMLVideoElement>('#receiver')!;
    const button = document.querySelector<HTMLButtonElement>('#start')!;
    type State = { runPromise: Promise<BrowserRunRaw> | null };
    const benchmarkWindow = window as typeof window & { __webscreenFpsBenchmark: State };
    benchmarkWindow.__webscreenFpsBenchmark = { runPromise: null };

    function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
      let timer: ReturnType<typeof setTimeout>;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      });
      return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
    }
    async function waitForIceComplete(peer: RTCPeerConnection): Promise<void> {
      if (peer.iceGatheringState === 'complete') return;
      await withTimeout(new Promise<void>((resolve) => {
        peer.addEventListener('icegatheringstatechange', () => {
          if (peer.iceGatheringState === 'complete') resolve();
        });
      }), 5_000, 'ICE gathering did not complete within 5 seconds');
    }
    async function configureSender(sender: RTCRtpSender): Promise<void> {
      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings.length ? parameters.encodings : [{}];
      parameters.encodings[0]!.maxBitrate = config.maxBitrate;
      parameters.encodings[0]!.scaleResolutionDownBy = config.scaleResolutionDownBy;
      parameters.degradationPreference = config.degradationPreference;
      try {
        await sender.setParameters(parameters);
      } catch {
        const fallback = sender.getParameters();
        fallback.encodings = fallback.encodings.length ? fallback.encodings : [{}];
        fallback.encodings[0]!.maxBitrate = config.maxBitrate;
        delete fallback.encodings[0]!.scaleResolutionDownBy;
        delete fallback.degradationPreference;
        await sender.setParameters(fallback);
      }
    }
    async function connectLoopback(track: MediaStreamTrack): Promise<{
      sender: RTCRtpSender; senderPeer: RTCPeerConnection; receiverPeer: RTCPeerConnection;
    }> {
      const senderPeer = new RTCPeerConnection();
      const receiverPeer = new RTCPeerConnection();
      try {
        const receiverPlaying = new Promise<void>((resolve, reject) => {
          receiverPeer.addEventListener('track', (event) => {
            receiver.srcObject = event.streams[0] ?? new MediaStream([event.track]);
            receiver.play().then(resolve, reject);
          }, { once: true });
        });
        const transceiver = senderPeer.addTransceiver(track, { direction: 'sendonly' });
        const sender = transceiver.sender;
        const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? [];
        const h264 = codecs.filter((codec) => /\/h264$/i.test(codec.mimeType));
        if (h264.length === 0) throw new Error('system Chrome has no H.264 encoder');
        transceiver.setCodecPreferences([...h264, ...codecs.filter((codec) => !h264.includes(codec))]);
        await configureSender(sender);
        await senderPeer.setLocalDescription(await senderPeer.createOffer());
        await waitForIceComplete(senderPeer);
        await receiverPeer.setRemoteDescription(senderPeer.localDescription!);
        await receiverPeer.setLocalDescription(await receiverPeer.createAnswer());
        await waitForIceComplete(receiverPeer);
        await senderPeer.setRemoteDescription(receiverPeer.localDescription!);
        await withTimeout(new Promise<void>((resolve) => {
          const check = (): void => { if (senderPeer.connectionState === 'connected') resolve(); };
          senderPeer.addEventListener('connectionstatechange', check);
          check();
        }), 5_000, 'loopback peer connection did not connect within 5 seconds');
        await withTimeout(receiverPlaying, 5_000, 'loopback receiver video did not play within 5 seconds');
        return { sender, senderPeer, receiverPeer };
      } catch (error) {
        senderPeer.close();
        receiverPeer.close();
        throw error;
      }
    }
    function startKeyframeRequests(sender: RTCRtpSender): {
      attempted: number; succeeded: number; error: string | null; stopped: boolean;
      timer?: ReturnType<typeof setTimeout>;
    } {
      const status = { attempted: 0, succeeded: 0, error: null as string | null, stopped: false,
        timer: undefined as ReturnType<typeof setTimeout> | undefined };
      type KeyframeSender = RTCRtpSender & { setParameters(
        parameters: RTCRtpSendParameters,
        options: { encodingOptions: Array<{ keyFrame: true }> }
      ): Promise<void> };
      const request = async (): Promise<void> => {
        if (status.stopped) return;
        status.attempted += 1;
        try {
          const parameters = sender.getParameters();
          await (sender as KeyframeSender).setParameters(parameters, {
            encodingOptions: parameters.encodings.map(() => ({ keyFrame: true })),
          });
          status.succeeded += 1;
          if (!status.stopped) status.timer = setTimeout(request, config.keyframeIntervalMs);
        } catch (error) {
          status.error = error instanceof Error ? error.message : String(error);
          status.stopped = true;
        }
      };
      void request();
      return status;
    }
    function safeVideoStats(report: RTCStatsReport): StatsRow[] {
      const all: Array<Record<string, unknown>> = [];
      report.forEach((row) => all.push(row as unknown as Record<string, unknown>));
      const outbound = all.filter((row) => row.type === 'outbound-rtp'
        && (row.kind === 'video' || row.mediaType === 'video'));
      const codecIds = new Set(outbound.map((row) => row.codecId)
        .filter((id): id is string => typeof id === 'string'));
      const keys = ['id', 'type', 'kind', 'mediaType', 'codecId', 'framesEncoded',
        'keyFramesEncoded', 'bytesSent', 'qpSum', 'totalEncodeTime', 'framesSent',
        'frameWidth', 'frameHeight', 'qualityLimitationReason'];
      const pick = (row: Record<string, unknown>, names: string[]): StatsRow =>
        Object.fromEntries(names.map((name) => [name, row[name]])) as unknown as StatsRow;
      return [...outbound.map((row) => pick(row, keys)), ...all
        .filter((row) => row.type === 'codec' && codecIds.has(String(row.id)))
        .map((row) => pick(row, ['id', 'type', 'mimeType']))];
    }
    async function runCapture(fps: number, durationSeconds: number): Promise<BrowserRunRaw> {
      let stream: MediaStream | undefined;
      let peers: Awaited<ReturnType<typeof connectLoopback>> | undefined;
      let keyframes: ReturnType<typeof startKeyframeRequests> | undefined;
      let countFrames = false;
      let captureFrames = 0;
      let frameCallbackId: number | undefined;
      const onVideoFrame = (): void => {
        if (countFrames) captureFrames += 1;
        frameCallbackId = preview.requestVideoFrameCallback(onVideoFrame);
      };
      frameCallbackId = preview.requestVideoFrameCallback(onVideoFrame);
      try {
        stream = await withTimeout(navigator.mediaDevices.getDisplayMedia({
          video: { width: { ideal: config.width }, height: { ideal: config.height },
            frameRate: { ideal: fps, max: fps } }, audio: false,
        }), config.captureTimeoutMs, `${config.captureMode} capture did not start within 15 seconds`);
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error('getDisplayMedia returned no video track');
        track.contentHint = config.contentHint;
        preview.srcObject = stream;
        await preview.play();
        peers = await connectLoopback(track);
        const baselineStats = safeVideoStats(await peers.sender.getStats());
        captureFrames = 0;
        countFrames = true;
        const startedAt = performance.now();
        keyframes = startKeyframeRequests(peers.sender);
        await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1_000));
        const elapsedMs = performance.now() - startedAt;
        countFrames = false;
        keyframes.stopped = true;
        clearTimeout(keyframes.timer);
        const endStats = safeVideoStats(await peers.sender.getStats());
        const rawSettings = track.getSettings() as Record<string, unknown>;
        return {
          requestedFps: fps, durationSeconds, elapsedMs, captureFrames, baselineStats, endStats,
          trackSettings: Object.fromEntries(config.safeSettingKeys
            .filter((key) => rawSettings[key] !== undefined).map((key) => [key, rawSettings[key]])),
          keyframeRequests: { attempted: keyframes.attempted, succeeded: keyframes.succeeded,
            error: keyframes.error },
        };
      } finally {
        countFrames = false;
        if (keyframes) { keyframes.stopped = true; clearTimeout(keyframes.timer); }
        if (frameCallbackId !== undefined) preview.cancelVideoFrameCallback(frameCallbackId);
        peers?.senderPeer.close(); peers?.receiverPeer.close();
        stream?.getTracks().forEach((track) => track.stop());
        preview.pause(); preview.srcObject = null;
        receiver.pause(); receiver.srcObject = null;
      }
    }
    button.addEventListener('click', () => {
      button.hidden = true;
      benchmarkWindow.__webscreenFpsBenchmark.runPromise = runCapture(
        Number(button.dataset.fps), Number(button.dataset.duration)
      ).finally(() => { button.hidden = false; });
    });
  }, {
    captureMode, width: settings.width, height: settings.height, maxBitrate: settings.maxBitrate,
    contentHint: settings.contentHint, degradationPreference: settings.degradationPreference,
    scaleResolutionDownBy: settings.scaleResolutionDownBy,
    keyframeIntervalMs: MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS,
    captureTimeoutMs: CAPTURE_TIMEOUT_MS, safeSettingKeys: SAFE_SETTING_KEYS,
  });
}
