import { describe, expect, test } from 'bun:test';

import { withRawAudioOpusParameters } from '../../src/lib/ui/audio-profile';
import {
  prioritizeH264,
  readVideoPublishStats,
  resolveWhipResourceUrl,
  startWhipPublisher,
} from '../../src/lib/ui/whip-publisher';
import {
  REALTIME_SCREEN_SHARE_VIDEO_SETTINGS,
  SCREEN_SHARE_VIDEO_SETTINGS,
} from '../../src/lib/ui/screen-share/video-profile';

describe('WHIP publisher', () => {
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
    const whipUrl = 'https://whip.example/live/Ab12Cd34Ef56/whip';
    expect(resolveWhipResourceUrl('/live/Ab12Cd34Ef56/whip/resource', whipUrl)).toBe(
      'https://whip.example/live/Ab12Cd34Ef56/whip/resource'
    );
    expect(resolveWhipResourceUrl('https://attacker.example/resource', whipUrl)).toBeNull();
    expect(resolveWhipResourceUrl('/live/other/whip/resource', whipUrl)).toBeNull();
  });

  test('raw 音声用に既存の Opus fmtp へ不足パラメータだけを補完する', () => {
    const answer = [
      'v=0',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1',
    ].join('\r\n');

    expect(withRawAudioOpusParameters(answer)).toBe([
      'v=0',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000',
    ].join('\r\n'));
  });

  test('raw 音声用に fmtp がない Opus だけへ fmtp 行を追加する', () => {
    const answer = [
      'a=rtpmap:111 opus/48000/2',
      'a=rtpmap:0 PCMU/8000',
      'a=fmtp:0 useinbandfec=1',
    ].join('\n');

    expect(withRawAudioOpusParameters(answer)).toBe([
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 stereo=1;sprop-stereo=1;maxaveragebitrate=128000',
      'a=rtpmap:0 PCMU/8000',
      'a=fmtp:0 useinbandfec=1',
    ].join('\n'));
  });

  test('raw 音声用の Opus fmtp は重複を正規化し、Opus 以外を変更しない', () => {
    const answer = [
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 stereo=0;stereo=1;maxaveragebitrate=64000;useinbandfec=1',
      'a=rtpmap:96 H264/90000',
      'a=fmtp:96 profile-level-id=42e01f',
    ].join('\n');

    expect(withRawAudioOpusParameters(answer)).toBe([
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000',
      'a=rtpmap:96 H264/90000',
      'a=fmtp:96 profile-level-id=42e01f',
    ].join('\n'));
  });

  test('H.264 映像とすべての音声 track を送出し、同じ入力で一度だけ再 publish できる', async () => {
    const previousSender = globalThis.RTCRtpSender;
    const previousConnection = globalThis.RTCPeerConnection;
    const requests: Array<{ url: string; init: RequestInit }> = [];
    let codecPreferences: RTCRtpCodec[] | undefined;
    const senderParameters: RTCRtpSendParameters[] = [];
    let keyframeRequests = 0;
    const addedAudioTracks: MediaStreamTrack[] = [];
    const remoteDescriptions: RTCSessionDescriptionInit[] = [];
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
      async setRemoteDescription(description: RTCSessionDescriptionInit) { remoteDescriptions.push(description); }
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
        whipUrl: 'https://whip.example/live/Ab12Cd34Ef56/whip',
        publishToken: 'first-token',
        // 再 publish と停止だけを見るケースなので、audio sender へ触らない legacy で固定する。
        audioProfile: 'legacy',
        videoSettings: SCREEN_SHARE_VIDEO_SETTINGS,
        fetchImpl: (async (url, options) => {
          requests.push({ url: String(url), init: options ?? {} });
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
        whipUrl: 'https://whip.example/live/Ab12Cd34Ef56/whip',
        publishToken: 'video-only-token',
        audioProfile: 'raw',
        videoSettings: SCREEN_SHARE_VIDEO_SETTINGS,
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
      expect(remoteDescriptions).toEqual([
        { type: 'answer', sdp: 'answer' },
        { type: 'answer', sdp: 'answer' },
        { type: 'answer', sdp: 'answer' },
      ]);
      expect(requests.map(({ url }) => url)).toEqual([
        'https://whip.example/live/Ab12Cd34Ef56/whip',
        'https://whip.example/live/Ab12Cd34Ef56/whip/resource',
        'https://whip.example/live/Ab12Cd34Ef56/whip',
        'https://whip.example/live/Ab12Cd34Ef56/whip/resource',
      ]);
      expect(requests[0]?.init.headers).toMatchObject({ Authorization: 'Bearer first-token' });
      expect(requests[1]?.init.headers).toMatchObject({ Authorization: 'Bearer extended-token' });
      expect(requests[2]?.init.headers).toMatchObject({ Authorization: 'Bearer extended-token' });
      expect(requests[3]?.init.headers).toMatchObject({ Authorization: 'Bearer extended-token' });
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

  test('解像度倍率が未指定の映像設定では sender encoding に代入しない', async () => {
    const restore = installWebRtcMocks(() => undefined);
    try {
      const publisher = await startWhipPublisher({
        ...testPublisherInput(),
        videoSettings: REALTIME_SCREEN_SHARE_VIDEO_SETTINGS,
      });
      publisher.close();

      expect(restore.parameters).toEqual([
        {
          maxBitrate: 1_500_000,
          scaleResolutionDownBy: undefined,
          degradationPreference: 'maintain-framerate',
        },
      ]);
      expect(restore.encodingKeys).toEqual([['maxBitrate']]);
    } finally {
      restore.globals();
    }
  });

  test('realtime 候補の full設定が拒否されたら maxBitrate-only fallback で倍率も劣化方針も残さない', async () => {
    const restore = installWebRtcMocks((parameters, attempt) => {
      if (attempt === 1) throw new Error('full settings rejected');
      return parameters;
    }, [
      { encodings: [{}] },
      { encodings: [{ scaleResolutionDownBy: 2 }], degradationPreference: 'maintain-resolution' },
    ]);
    try {
      const publisher = await startWhipPublisher({
        ...testPublisherInput(() => { restore.postCalls += 1; }),
        videoSettings: REALTIME_SCREEN_SHARE_VIDEO_SETTINGS,
      });
      publisher.close();

      expect(restore.parameters).toEqual([
        { maxBitrate: 1_500_000, scaleResolutionDownBy: undefined, degradationPreference: 'maintain-framerate' },
        { maxBitrate: 1_500_000, scaleResolutionDownBy: undefined, degradationPreference: undefined },
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

  test('legacy では Opus を含む answer を加工せず audio sender の上限も変更しない', async () => {
    const restore = installWebRtcMocks(() => undefined);
    const audioTrack = { stop() {} } as unknown as MediaStreamTrack;
    const answerSdp = ['a=rtpmap:111 opus/48000/2', 'a=fmtp:111 minptime=10;useinbandfec=1'].join('\r\n');
    try {
      const publisher = await startWhipPublisher({
        ...testPublisherInput(),
        stream: {
          getVideoTracks: () => [{ contentHint: '', stop() {} }],
          getAudioTracks: () => [audioTrack],
        } as unknown as MediaStream,
        audioProfile: 'legacy',
        fetchImpl: (async () => new Response(answerSdp, {
          status: 201,
          headers: { Location: '/live/Ab12Cd34Ef56/whip/resource' },
        })) as unknown as typeof fetch,
      });
      publisher.close();

      expect(restore.audioParameters).toEqual([]);
      expect(restore.remoteDescriptions).toEqual([{ type: 'answer', sdp: answerSdp }]);
    } finally {
      restore.globals();
    }
  });

  test('既定の raw は Opus answer と audio sender の上限を変更する', async () => {
    const restore = installWebRtcMocks(() => undefined);
    const audioTrack = { stop() {} } as unknown as MediaStreamTrack;
    try {
      const publisher = await startWhipPublisher({
        ...testPublisherInput(),
        stream: {
          getVideoTracks: () => [{ contentHint: '', stop() {} }],
          getAudioTracks: () => [audioTrack],
        } as unknown as MediaStream,
        audioProfile: 'raw',
        fetchImpl: (async () => new Response([
          'a=rtpmap:111 opus/48000/2',
          'a=fmtp:111 minptime=10',
        ].join('\r\n'), {
          status: 201,
          headers: { Location: '/live/Ab12Cd34Ef56/whip/resource' },
        })) as unknown as typeof fetch,
      });
      publisher.close();

      expect(restore.audioParameters).toEqual([128_000]);
      expect(restore.remoteDescriptions).toEqual([{
        type: 'answer',
        sdp: [
          'a=rtpmap:111 opus/48000/2',
          'a=fmtp:111 minptime=10;stereo=1;sprop-stereo=1;maxaveragebitrate=128000',
        ].join('\r\n'),
      }]);
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
  encodingKeys: string[][];
  getParametersCalls: number;
  postCalls: number;
  closed: number;
  audioParameters: Array<number | undefined>;
  remoteDescriptions: RTCSessionDescriptionInit[];
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
    encodingKeys: [],
    getParametersCalls: 0,
    postCalls: 0,
    closed: 0,
    audioParameters: [],
    remoteDescriptions: [],
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
            state.encodingKeys.push(Object.keys(parameters.encodings?.[0] ?? {}));
            setParameters(parameters, state.parameters.length);
          },
        },
      } as unknown as RTCRtpTransceiver;
    }
    addTrack() {
      return {
        getParameters: () => ({}),
        setParameters: async (parameters: RTCRtpSendParameters) => {
          state.audioParameters.push(parameters.encodings?.[0]?.maxBitrate);
        },
      } as unknown as RTCRtpSender;
    }
    async createOffer() { return { sdp: 'offer', type: 'offer' } as RTCSessionDescriptionInit; }
    async setLocalDescription() {}
    async setRemoteDescription(description: RTCSessionDescriptionInit) {
      state.remoteDescriptions.push(description);
    }
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
    whipUrl: 'https://webscreen.tv/live/Ab12Cd34Ef56/whip',
    publishToken: 'token',
    audioProfile: 'raw',
    videoSettings: SCREEN_SHARE_VIDEO_SETTINGS,
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

describe('readVideoPublishStats', () => {
  function statsPc(entries: Array<Record<string, unknown> & { id: string }>): RTCPeerConnection {
    const report = new Map(entries.map((entry) => [entry.id, entry]));
    return { getStats: async () => report } as unknown as RTCPeerConnection;
  }

  test('RTX(bytesSent:0)が先でも H264 本体の outbound を選ぶ', async () => {
    const pc = statsPc([
      { id: 'codec-rtx', type: 'codec', mimeType: 'video/rtx' },
      { id: 'codec-h264', type: 'codec', mimeType: 'video/H264' },
      { id: 'out-rtx', type: 'outbound-rtp', kind: 'video', codecId: 'codec-rtx', bytesSent: 0 },
      { id: 'out-h264', type: 'outbound-rtp', kind: 'video', codecId: 'codec-h264', bytesSent: 4096, framesEncoded: 30 },
    ]);
    expect(await readVideoPublishStats(pc)).toEqual({ bytesSent: 4096, framesEncoded: 30 });
  });

  test('映像 outbound-rtp が無ければ null', async () => {
    const pc = statsPc([
      { id: 'codec-opus', type: 'codec', mimeType: 'audio/opus' },
      { id: 'out-audio', type: 'outbound-rtp', kind: 'audio', codecId: 'codec-opus', bytesSent: 512 },
    ]);
    expect(await readVideoPublishStats(pc)).toBeNull();
  });

  test('getStats が失敗したら null', async () => {
    const pc = { getStats: async () => { throw new Error('closed'); } } as unknown as RTCPeerConnection;
    expect(await readVideoPublishStats(pc)).toBeNull();
  });
});
