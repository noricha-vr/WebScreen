import { describe, expect, test } from 'bun:test';

import {
  MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS,
  startWhipPublisher,
  type WhipPublisher,
} from '../../src/lib/ui/whip-publisher';
import { SCREEN_SHARE_VIDEO_SETTINGS } from '../../src/lib/ui/screen-share/video-profile';

const TIMER_MARGIN_MS = 50;

describe('WHIP keyframe requester', () => {
  test('通常入力ではremote answer後もkeyframeを要求しない', async () => {
    const restore = installKeyframeMocks();
    let publisher: WhipPublisher | undefined;
    try {
      publisher = await startWhipPublisher(publisherInput());
      expect(restore.requests).toEqual([]);
    } finally {
      publisher?.close();
      restore.globals();
    }
  });

  test('opt-in後にfresh parametersの全encodingへ直列要求する', async () => {
    const answer = deferred<void>();
    const restore = installKeyframeMocks({
      answer: answer.promise,
      snapshots: [{ encodings: [{}] }, { encodings: [{}] }, { encodings: [{}, {}] }],
    });
    let publisher: WhipPublisher | undefined;
    try {
      const starting = startWhipPublisher(publisherInput({ keyframeRequestIntervalMs: MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS }));
      await Promise.resolve();
      expect(restore.requests).toEqual([]);

      answer.resolve();
      publisher = await starting;
      expect(restore.requests).toEqual([{ connection: 0, encodingOptions: [{ keyFrame: true }] }]);

      await Bun.sleep(MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS + TIMER_MARGIN_MS);
      expect(restore.requests).toEqual([
        { connection: 0, encodingOptions: [{ keyFrame: true }] },
        { connection: 0, encodingOptions: [{ keyFrame: true }, { keyFrame: true }] },
      ]);
      expect(restore.getParametersCalls).toBe(3);
    } finally {
      publisher?.close();
      restore.globals();
    }
  });

  test('未解決要求を重複せず、close後のlate resolveで再開しない', async () => {
    const pending = deferred<void>();
    const restore = installKeyframeMocks({ keyframeRequest: () => pending.promise });
    let publisher: WhipPublisher | undefined;
    try {
      publisher = await startWhipPublisher(publisherInput({ keyframeRequestIntervalMs: MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS }));
      expect(restore.requests).toHaveLength(1);
      await Bun.sleep(MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS + TIMER_MARGIN_MS);
      expect(restore.requests).toHaveLength(1);

      publisher.close();
      pending.resolve();
      await Bun.sleep(MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS + TIMER_MARGIN_MS);
      expect(restore.requests).toHaveLength(1);
    } finally {
      publisher?.close();
      restore.globals();
    }
  });

  test('同期throwとrejectはpublishを維持しrequesterだけを停止する', async () => {
    for (const keyframeRequest of [
      () => { throw new Error('unsupported'); },
      () => Promise.reject(new Error('unsupported')),
    ]) {
      const restore = installKeyframeMocks({ keyframeRequest });
      let publisher: WhipPublisher | undefined;
      try {
        publisher = await startWhipPublisher(publisherInput({ keyframeRequestIntervalMs: MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS }));
        await Promise.resolve();
        expect(restore.requests).toHaveLength(1);
        expect(restore.closed).toEqual([]);
        await Bun.sleep(MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS + TIMER_MARGIN_MS);
        expect(restore.requests).toHaveLength(1);
      } finally {
        publisher?.close();
        restore.globals();
      }
    }
  });

  test('republishは旧requesterを停止し、新senderのrequesterだけを継続する', async () => {
    const restore = installKeyframeMocks();
    let publisher: WhipPublisher | undefined;
    let replacement: WhipPublisher | undefined;
    try {
      publisher = await startWhipPublisher(publisherInput({ keyframeRequestIntervalMs: MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS }));
      replacement = await publisher.republish();
      expect(restore.requests.map(({ connection }) => connection)).toEqual([0, 1]);
      expect(restore.closed).toEqual([0]);

      await Bun.sleep(MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS + TIMER_MARGIN_MS);
      expect(restore.requests.map(({ connection }) => connection)).toEqual([0, 1, 1]);
    } finally {
      replacement?.close();
      publisher?.close();
      restore.globals();
    }
  });
});

interface KeyframeRequest {
  connection: number;
  encodingOptions: Array<{ keyFrame: true }>;
}

interface KeyframeMockInput {
  answer?: Promise<void>;
  keyframeRequest?: () => Promise<void> | void;
  snapshots?: Array<Partial<RTCRtpSendParameters>>;
}

interface KeyframeMockState {
  closed: number[];
  getParametersCalls: number;
  globals: () => void;
  requests: KeyframeRequest[];
}

function installKeyframeMocks(input: KeyframeMockInput = {}): KeyframeMockState {
  const previousSender = globalThis.RTCRtpSender;
  const previousConnection = globalThis.RTCPeerConnection;
  const snapshots = input.snapshots ?? [];
  const state: KeyframeMockState = { closed: [], getParametersCalls: 0, requests: [], globals: restore };
  let connectionCount = 0;
  class Sender {
    static getCapabilities() { return { codecs: [{ mimeType: 'video/H264' }] }; }
  }
  class Connection {
    readonly index = connectionCount++;
    iceGatheringState: RTCIceGatheringState = 'complete';
    localDescription = { sdp: 'offer', type: 'offer' } as RTCSessionDescription;
    addTransceiver() {
      return {
        setCodecPreferences() {},
        sender: {
          getParameters: () => (snapshots[state.getParametersCalls++] ?? { encodings: [{}] }) as RTCRtpSendParameters,
          setParameters: (_parameters: RTCRtpSendParameters, options?: { encodingOptions: Array<{ keyFrame: true }> }) => {
            if (!options) return Promise.resolve();
            state.requests.push({ connection: this.index, ...options });
            return Promise.resolve(input.keyframeRequest?.());
          },
        },
      } as unknown as RTCRtpTransceiver;
    }
    addTrack() { return {} as RTCRtpSender; }
    async createOffer() { return { sdp: 'offer', type: 'offer' } as RTCSessionDescriptionInit; }
    async setLocalDescription() {}
    async setRemoteDescription() { await input.answer; }
    close() { state.closed.push(this.index); }
    addEventListener() {}
    removeEventListener() {}
  }
  Object.defineProperty(globalThis, 'RTCRtpSender', { configurable: true, value: Sender });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Connection });
  return state;

  function restore(): void {
    Object.defineProperty(globalThis, 'RTCRtpSender', { configurable: true, value: previousSender });
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: previousConnection });
  }
}

function publisherInput(
  overrides: Partial<Parameters<typeof startWhipPublisher>[0]> = {}
): Parameters<typeof startWhipPublisher>[0] {
  return {
    stream: {
      getVideoTracks: () => [{ contentHint: '', stop() {} }],
      getAudioTracks: () => [],
    } as unknown as MediaStream,
    whipUrl: 'https://webscreen.tv/live/Ab12Cd34Ef56/whip',
    publishToken: 'token',
    audioProfile: 'raw',
    videoSettings: SCREEN_SHARE_VIDEO_SETTINGS,
    fetchImpl: (async (_url, options) => {
      if (options?.method === 'POST') {
        return new Response('answer', { status: 201, headers: { Location: '/live/Ab12Cd34Ef56/whip/resource' } });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch,
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}
