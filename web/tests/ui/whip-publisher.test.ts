import { describe, expect, test } from 'bun:test';

import { STREAM_WHIP_BASE_URL } from '../../src/lib/contracts/streams';
import {
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

  test('H.264 と映像送出パラメータを設定し、DELETE は最新 token を1回だけ使う', async () => {
    const previousSender = globalThis.RTCRtpSender;
    const previousConnection = globalThis.RTCPeerConnection;
    const requests: RequestInit[] = [];
    let codecPreferences: RTCRtpCodec[] | undefined;
    let senderParameters: RTCRtpSendParameters | undefined;
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
      const publisher = await startWhipPublisher({
        stream: { getVideoTracks: () => [{ contentHint: '', stop() {} }] } as unknown as MediaStream,
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
          return new Response(null, { status: 204 });
        }) as typeof fetch,
      });
      publisher.setPublishToken('extended-token');
      publisher.close();
      await publisher.deleteResource();
      await publisher.deleteResource();

      expect(codecPreferences?.[0]?.mimeType).toBe('video/H264');
      expect(codecPreferences?.map((codec) => codec.mimeType)).toEqual([
        'video/H264',
        'video/VP8',
        'video/rtx',
      ]);
      expect(senderParameters).toMatchObject({
        encodings: [{ maxBitrate: 1_500_000 }],
        degradationPreference: 'maintain-resolution',
      });
      expect(requests[0]?.headers).toMatchObject({ Authorization: 'Bearer first-token' });
      expect(requests[1]?.headers).toMatchObject({ Authorization: 'Bearer extended-token' });
      expect(requests).toHaveLength(2);
      expect(closed).toBe(1);
    } finally {
      Object.defineProperty(globalThis, 'RTCRtpSender', { configurable: true, value: previousSender });
      Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: previousConnection });
    }
  });
});
