import { STREAM_WHIP_BASE_URL } from '../contracts/streams';

/** WHIP publish 時にユーザーへ意味のある対処を示すための失敗種別。 */
export type WhipPublishErrorCode = 'H264_UNAVAILABLE' | 'WHIP_REQUEST_FAILED' | 'WHIP_RESPONSE_INVALID';

/** WHIP publish が開始できなかった理由を保持する。 */
export class WhipPublishError extends Error {
  constructor(readonly code: WhipPublishErrorCode) {
    super('WHIP publish failed');
  }
}

/** WHIP のセッション URL を、固定した配信オリジンから組み立てる。 */
export function buildWhipUrl(streamId: string): string {
  return `${STREAM_WHIP_BASE_URL}/${encodeURIComponent(streamId)}/whip`;
}

/** WHIP 応答の resource URL が、要求した同一配信オリジン配下か検証する。 */
export function resolveWhipResourceUrl(location: string, streamId: string): string | null {
  const endpoint = new URL(buildWhipUrl(streamId));
  const resource = new URL(location, endpoint);
  const resourcePrefix = `${endpoint.pathname}/`;
  if (resource.origin !== endpoint.origin || !resource.pathname.startsWith(resourcePrefix)) {
    return null;
  }
  return resource.toString();
}

/** WebRTC capability から H.264 を先頭にした優先順を返す。 */
export function prioritizeH264(codecs: readonly RTCRtpCodec[]): RTCRtpCodec[] | null {
  const h264 = codecs.filter((codec) => /\/h264$/i.test(codec.mimeType));
  if (h264.length === 0) return null;
  return [...h264, ...codecs.filter((codec) => !/\/h264$/i.test(codec.mimeType))];
}

/** WHIP 接続を終了するために必要な操作を返す。 */
export interface WhipPublisher {
  close(): Promise<void>;
  setPublishToken(publishToken: string): void;
}

interface StartWhipPublisherInput {
  stream: MediaStream;
  streamId: string;
  publishToken: string;
  fetchImpl?: typeof fetch;
}

const MAX_BITRATE = 1_500_000;
const ICE_GATHERING_TIMEOUT_MS = 15_000;

/** 選択済みの画面を H.264 固定で WHIP endpoint へ publish する。 */
export async function startWhipPublisher(input: StartWhipPublisherInput): Promise<WhipPublisher> {
  const track = input.stream.getVideoTracks()[0];
  if (!track) throw new WhipPublishError('WHIP_RESPONSE_INVALID');

  const preferredCodecs = videoCodecPreferences();
  if (!preferredCodecs) throw new WhipPublishError('H264_UNAVAILABLE');

  const peerConnection = new RTCPeerConnection({ iceServers: [] });
  let resourceUrl: string | null = null;
  try {
    const transceiver = peerConnection.addTransceiver(track, { direction: 'sendonly' });
    transceiver.setCodecPreferences(preferredCodecs);
    await configureVideoSender(transceiver.sender);
    // AVPro は Opus を再生できない。AAC 変換を持たない今回は音声を送出しない。
    track.contentHint = 'text';

    await peerConnection.setLocalDescription(await peerConnection.createOffer());
    await waitForIceGathering(peerConnection);
    const response = await publishOffer(peerConnection, input, input.fetchImpl ?? fetch);
    resourceUrl = response.resourceUrl;
    await peerConnection.setRemoteDescription({ type: 'answer', sdp: response.answerSdp });
    return publisherFor(peerConnection, resourceUrl, input.publishToken, input.fetchImpl ?? fetch);
  } catch (error) {
    peerConnection.close();
    if (resourceUrl) await deleteWhipResource(resourceUrl, input.publishToken, input.fetchImpl ?? fetch);
    throw error;
  }
}

function videoCodecPreferences(): RTCRtpCodec[] | null {
  return prioritizeH264(RTCRtpSender.getCapabilities('video')?.codecs ?? []);
}

async function configureVideoSender(sender: RTCRtpSender): Promise<void> {
  const parameters = sender.getParameters();
  parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
  parameters.encodings[0]!.maxBitrate = MAX_BITRATE;
  parameters.degradationPreference = 'maintain-resolution';
  await sender.setParameters(parameters);
}

async function waitForIceGathering(peerConnection: RTCPeerConnection): Promise<void> {
  if (peerConnection.iceGatheringState === 'complete') return;

  await new Promise<void>((resolve) => {
    const timeout = globalThis.setTimeout(done, ICE_GATHERING_TIMEOUT_MS);
    function done(): void {
      globalThis.clearTimeout(timeout);
      peerConnection.removeEventListener('icegatheringstatechange', onChange);
      resolve();
    }
    function onChange(): void {
      if (peerConnection.iceGatheringState === 'complete') done();
    }
    peerConnection.addEventListener('icegatheringstatechange', onChange);
  });
}

async function publishOffer(
  peerConnection: RTCPeerConnection,
  input: StartWhipPublisherInput,
  fetchImpl: typeof fetch
): Promise<{ resourceUrl: string; answerSdp: string }> {
  const response = await fetchImpl(buildWhipUrl(input.streamId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.publishToken}`,
      'Content-Type': 'application/sdp',
    },
    body: peerConnection.localDescription?.sdp,
  });
  if (response.status !== 201) throw new WhipPublishError('WHIP_REQUEST_FAILED');

  const location = response.headers.get('Location');
  const resourceUrl = location ? resolveWhipResourceUrl(location, input.streamId) : null;
  if (!resourceUrl) throw new WhipPublishError('WHIP_RESPONSE_INVALID');
  return { resourceUrl, answerSdp: await response.text() };
}

/** 後続の失敗で残った WHIP resource を best-effort で破棄する。 */
async function deleteWhipResource(
  resourceUrl: string,
  publishToken: string,
  fetchImpl: typeof fetch
): Promise<void> {
  try {
    await fetchImpl(resourceUrl, { method: 'DELETE', headers: { Authorization: `Bearer ${publishToken}` } });
  } catch {
    // 元の publish 失敗を隠さず、PeerConnection は必ず閉じる。
  }
}

function publisherFor(
  peerConnection: RTCPeerConnection,
  resourceUrl: string,
  publishToken: string,
  fetchImpl: typeof fetch
): WhipPublisher {
  let currentPublishToken = publishToken;
  return {
    async close(): Promise<void> {
      try {
        const response = await fetchImpl(resourceUrl, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${currentPublishToken}` },
        });
        if (!response.ok) throw new WhipPublishError('WHIP_REQUEST_FAILED');
      } finally {
        peerConnection.close();
      }
    },
    setPublishToken(nextPublishToken: string): void {
      currentPublishToken = nextPublishToken;
    },
  };
}
