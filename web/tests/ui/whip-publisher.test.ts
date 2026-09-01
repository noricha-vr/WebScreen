import { describe, expect, test } from 'bun:test';

import { STREAM_WHIP_BASE_URL } from '../../src/lib/contracts/streams';
import {
  SCREEN_SHARE_VIDEO_SETTINGS,
  buildWhipUrl,
  prioritizeH264,
  resolveWhipResourceUrl,
  startWhipPublisher,
} from '../../src/lib/ui/whip-publisher';

describe('WHIP publisher', () => {
  test('固定済みの配信オリジンから stream ID ごとの WHIP URL を作る', () => {
    expect(buildWhipUrl('Ab12Cd34Ef56')).toBe(`${STREAM_WHIP_BASE_URL}/Ab12Cd34Ef56/whip`);
  });

  test('画面共有の映像設定を採用設定へ固定する', () => {
    expect(SCREEN_SHARE_VIDEO_SETTINGS).toEqual({
      width: 1280,
      height: 720,
      frameRate: 30,
      maxBitrate: 1_200_000,
      contentHint: 'detail',
      degradationPreference: 'maintain-resolution',
      scaleResolutionDownBy: 1,
    });
  });

  test('H.264 を最優先にし、H.264 が無ければ開始不可を示す', () => {
    const codecs = [
      { mimeType: 'video/VP8' },
      { mimeType: 'video/H264' },
      { mimeType: 'video/rtx' },
    ] as RTCRtpCodec[];

    expect(prioritizeH264(codecs)?.map((codec) => codec.mimeType)).toEqual([
      'video/H264',
      'video/VP8',
      'video/rtx',
    ]);
    expect(prioritizeH264([{ mimeType: 'video/VP9' }] as RTCRtpCodec[])).toBeNull();
  });

  test('WHIP resource は要求した配信オリジンとパス配下だけを許可する', () => {
    expect(resolveWhipResourceUrl('/live/Ab12Cd34Ef56/whip/resource', 'Ab12Cd34Ef56')).toBe(
      'https://webscreen.tv/live/Ab12Cd34Ef56/whip/resource'
    );
    expect(resolveWhipResourceUrl('https://attacker.example/resource', 'Ab12Cd34Ef56')).toBeNull();
    expect(resolveWhipResourceUrl('/live/other/whip/resource', 'Ab12Cd34Ef56')).toBeNull();
  });

  test('H.264 映像とすべての音声 track を送出し、同じ入力で一度だけ再 publish できる', async () => {
    const previousSender = globalThis.RTCRtpSender;
    const previousConnection = globalThis.RTCPeerConnection;
    const requests: RequestInit[] = [];
    let codecPreferences: RTCRtpCodec[] | undefined;
    const senderParameters: RTCRtpSendParameters[] = [];
    let keyframeRequests = 0;
    const addedAudioTracks: MediaStreamTrack[] = [];
    let delayedDelete: ReturnType<typeof deferred<Response>> | null = null;
    let closed = 0;
    class Sender {
      static getCapabilities() {
        return {
          codecs: [
            { mimeType: 'video/VP8' },
            { mimeType: 'video/H264' },
            { mimeType: 'video/rtx' },
          ],
        };
      }
    }
    class Connection {
      iceGatheringState: RTCIceGatheringState = 'complete';
      localDescription = { sdp: 'offer', type: 'offer' } as RTCSessionDescription;
      addTransceiver() {
        return {
          setCodecPreferences: (codecs: RTCRtpCodec[]) => { codecPreferences = codecs; },
          sender: {
            getParameters: () => ({}),
            setParameters: async (parameters: RTCRtpSendParameters, options?: unknown) => {
              if (options) keyframeRequests += 1;
              else senderParameters.push(parameters);
            },
          },
        } as unknown as RTCRtpTransceiver;
      }
      addTrack(track: MediaStreamTrack) {
        addedAudioTracks.push(track);
        return {} as RTCRtpSender;
      }
      async createOffer() { return { sdp: 'offer', type: 'offer' } as RTCSessionDescriptionInit; }
      async setLocalDescription() {}
      async setRemoteDescription() {}
      close() { closed += 1; }
      addEventListener() {}
      removeEventListener() {}
    }
    Object.defineProperty(globalThis, 'RTCRtpSender', { configurable: true, value: Sender });
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Connection });
    try {
      const videoTrack = { contentHint: '', stop() {} } as unknown as MediaStreamTrack;
      const audioTracks = [{ stop() {} }, { stop() {} }] as unknown as MediaStreamTrack[];
      const stream = {
        getVideoTracks: () => [videoTrack],
        getAudioTracks: () => audioTracks,
      } as unknown as MediaStream;
      const publisher = await startWhipPublisher({
        stream,
        streamId: 'Ab12Cd34Ef56',
        publishToken: 'first-token',
        fetchImpl: (async (_url, options) => {
          requests.push(options ?? {});
          if (options?.method === 'POST') {
            return new Response('answer', {
              status: 201,
              headers: { Location: '/live/Ab12Cd34Ef56/whip/resource' },
            });
          }
          if (delayedDelete) return delayedDelete.promise;
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      });
      publisher.setPublishToken('extended-token');
      const retry = publisher.republish();
      expect(publisher.republish()).toBe(retry);
      const republished = await retry;
      delayedDelete = deferred<Response>();
      let stopCompleted = false;
      const stopped = republished.stop().then(() => { stopCompleted = true; });
      await Promise.resolve();
      expect(stopCompleted).toBe(false);
      delayedDelete.resolve(new Response(null, { status: 204 }));
      await stopped;

      const videoOnly = await startWhipPublisher({
        stream: {
          getVideoTracks: () => [{ contentHint: '', stop() {} }],
          getAudioTracks: () => [],
        } as unknown as MediaStream,
        streamId: 'Ab12Cd34Ef56',
        publishToken: 'video-only-token',
        fetchImpl: (async () => new Response('answer', {
          status: 201,
          headers: { Location: '/live/Ab12Cd34Ef56/whip/video-only' },
        })) as unknown as typeof fetch,
      });
      videoOnly.close();

      expect(codecPreferences?.[0]?.mimeType).toBe('video/H264');
      expect(codecPreferences?.map((codec) => codec.mimeType)).toEqual([
        'video/H264',
        'video/VP8',
        'video/rtx',
      ]);
      expect(senderParameters.map(({ encodings, degradationPreference }) => ({ encodings, degradationPreference }))).toEqual(Array.from({ length: 3 }, () => ({
        encodings: [{
          maxBitrate: SCREEN_SHARE_VIDEO_SETTINGS.maxBitrate,
          scaleResolutionDownBy: SCREEN_SHARE_VIDEO_SETTINGS.scaleResolutionDownBy,
        }],
        degradationPreference: SCREEN_SHARE_VIDEO_SETTINGS.degradationPreference,
      })));
      expect(videoTrack.contentHint).toBe(SCREEN_SHARE_VIDEO_SETTINGS.contentHint);
      expect(addedAudioTracks).toEqual([...audioTracks, ...audioTracks]);
      expect(requests[0]?.headers).toMatchObject({ Authorization: 'Bearer first-token' });
      expect(requests[1]?.headers).toMatchObject({ Authorization: 'Bearer extended-token' });
      expect(requests[2]?.headers).toMatchObject({ Authorization: 'Bearer extended-token' });
      expect(requests[3]?.headers).toMatchObject({ Authorization: 'Bearer extended-token' });
      expect(requests).toHaveLength(4);
      expect(closed).toBe(3);
      expect(keyframeRequests).toBe(0);
    } finally {
      Object.defineProperty(globalThis, 'RTCRtpSender', { configurable: true, value: previousSender });
      Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: previousConnection });
    }
  });

  test('full設定が拒否されたらfresh parametersでmaxBitrate-only fallbackを1回だけ試す', async () => {
    const restore = installWebRtcMocks((parameters, attempt) => {
      if (attempt === 1) throw new Error('full settings rejected');
      return parameters;
    }, [
      { encodings: [{}] },
      { encodings: [{ scaleResolutionDownBy: 2 }], degradationPreference: 'maintain-framerate' },
    ]);
    try {
      const publisher = await startWhipPublisher(testPublisherInput(() => { restore.postCalls += 1; }));
      publisher.close();

      expect(restore.parameters).toEqual([
        { maxBitrate: 1_200_000, scaleResolutionDownBy: 1, degradationPreference: 'maintain-resolution' },
        { maxBitrate: 1_200_000, scaleResolutionDownBy: undefined, degradationPreference: undefined },
      ]);
      expect(restore.getParametersCalls).toBe(2);
      expect(restore.postCalls).toBe(1);
    } finally {
      restore.globals();
    }
  });

  test('full設定とfallbackがともに拒否されたらPOSTせず接続を閉じてfallback例外を返す', async () => {
    const fallbackError = new Error('fallback rejected');
    const restore = installWebRtcMocks((_parameters, attempt) => {
      throw attempt === 1 ? new Error('full settings rejected') : fallbackError;
    });
    try {
      await expect(startWhipPublisher(testPublisherInput())).rejects.toBe(fallbackError);

      expect(restore.parameters).toEqual([
        { maxBitrate: 1_200_000, scaleResolutionDownBy: 1, degradationPreference: 'maintain-resolution' },
        { maxBitrate: 1_200_000, scaleResolutionDownBy: undefined, degradationPreference: undefined },
      ]);
      expect(restore.postCalls).toBe(0);
      expect(restore.closed).toBe(1);
    } finally {
      restore.globals();
    }
  });

});

interface WebRtcMockState {
  parameters: Array<{
    maxBitrate: number | undefined;
    scaleResolutionDownBy: number | undefined;
    degradationPreference: RTCDegradationPreference | undefined;
  }>;
  getParametersCalls: number;
  postCalls: number;
  closed: number;
  globals: () => void;
}

function installWebRtcMocks(
  setParameters: (parameters: RTCRtpSendParameters, attempt: number) => void,
  parameterSnapshots: Partial<RTCRtpSendParameters>[] = [{}, {}]
): WebRtcMockState {
  const previousSender = globalThis.RTCRtpSender;
  const previousConnection = globalThis.RTCPeerConnection;
  const state: WebRtcMockState = {
    parameters: [],
    getParametersCalls: 0,
    postCalls: 0,
    closed: 0,
    globals: () => {
      Object.defineProperty(globalThis, 'RTCRtpSender', { configurable: true, value: previousSender });
      Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: previousConnection });
    },
  };
  class Sender {
    static getCapabilities() {
      return { codecs: [{ mimeType: 'video/H264' }] };
    }
  }
  class Connection {
    iceGatheringState: RTCIceGatheringState = 'complete';
    localDescription = { sdp: 'offer', type: 'offer' } as RTCSessionDescription;
    addTransceiver() {
      return {
        setCodecPreferences() {},
        sender: {
          getParameters: () => (parameterSnapshots[state.getParametersCalls++] ?? {}) as RTCRtpSendParameters,
          setParameters: async (parameters: RTCRtpSendParameters, options?: unknown) => {
            if (options) return;
            state.parameters.push({
              maxBitrate: parameters.encodings?.[0]?.maxBitrate,
              scaleResolutionDownBy: parameters.encodings?.[0]?.scaleResolutionDownBy,
              degradationPreference: parameters.degradationPreference,
            });
            setParameters(parameters, state.parameters.length);
          },
        },
      } as unknown as RTCRtpTransceiver;
    }
    addTrack() { return {} as RTCRtpSender; }
    async createOffer() { return { sdp: 'offer', type: 'offer' } as RTCSessionDescriptionInit; }
    async setLocalDescription() {}
    async setRemoteDescription() {}
    close() { state.closed += 1; }
    addEventListener() {}
    removeEventListener() {}
  }
  Object.defineProperty(globalThis, 'RTCRtpSender', { configurable: true, value: Sender });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Connection });
  return state;
}

function testPublisherInput(onPost: () => void = () => {}): Parameters<typeof startWhipPublisher>[0] {
  return {
    stream: {
      getVideoTracks: () => [{ contentHint: '', stop() {} }],
      getAudioTracks: () => [],
    } as unknown as MediaStream,
    streamId: 'Ab12Cd34Ef56',
    publishToken: 'token',
    fetchImpl: (async (_url, options) => {
      if (options?.method === 'POST') {
        onPost();
        return new Response('answer', { status: 201, headers: { Location: '/live/Ab12Cd34Ef56/whip/resource' } });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
