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
    let senderParameters: RTCRtpSendParameters | undefined;
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
            setParameters: async (parameters: RTCRtpSendParameters) => { senderParameters = parameters; },
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
      expect(senderParameters).toMatchObject({
        encodings: [{ maxBitrate: SCREEN_SHARE_VIDEO_SETTINGS.maxBitrate }],
        degradationPreference: SCREEN_SHARE_VIDEO_SETTINGS.degradationPreference,
      });
      expect(videoTrack.contentHint).toBe(SCREEN_SHARE_VIDEO_SETTINGS.contentHint);
      expect(addedAudioTracks).toEqual([...audioTracks, ...audioTracks]);
      expect(requests[0]?.headers).toMatchObject({ Authorization: 'Bearer first-token' });
      expect(requests[1]?.headers).toMatchObject({ Authorization: 'Bearer extended-token' });
      expect(requests[2]?.headers).toMatchObject({ Authorization: 'Bearer extended-token' });
      expect(requests[3]?.headers).toMatchObject({ Authorization: 'Bearer extended-token' });
      expect(requests).toHaveLength(4);
      expect(closed).toBe(3);
    } finally {
      Object.defineProperty(globalThis, 'RTCRtpSender', { configurable: true, value: previousSender });
      Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: previousConnection });
    }
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
