import { configureRawAudioSender, withRawAudioOpusParameters, type AudioProfile } from './audio-profile';
import { MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS } from './stream-profile';

export { MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS } from './stream-profile';

/** WHIP publish 時にユーザーへ意味のある対処を示すための失敗種別。 */
export type WhipPublishErrorCode = 'H264_UNAVAILABLE' | 'WHIP_REQUEST_FAILED' | 'WHIP_RESPONSE_INVALID';

/** WHIP publish が開始できなかった理由を保持する。 */
export class WhipPublishError extends Error {
  constructor(readonly code: WhipPublishErrorCode) {
    super('WHIP publish failed');
  }
}

/** WHIP 応答の resource URL が、要求した同一配信オリジン配下か検証する。 */
export function resolveWhipResourceUrl(location: string, whipUrl: string): string | null {
  const endpoint = new URL(whipUrl);
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

/**
 * 映像 outbound-rtp の送出量。失敗診断で「H.264 を 1 バイトも送れていない」のか
 * 「送れているのに health 未達」なのかを切り分けるために使う。
 *
 * bytesSent / framesEncoded は欠落しうる（Safari は framesEncoded を返さない）。
 * 欠落を 0 に潰すと Safari 利用者全員を no-video と誤分類するため、そのまま
 * undefined で保持する。
 */
export interface VideoPublishStats {
  bytesSent: number | undefined;
  framesEncoded: number | undefined;
}

/** WHIP 接続を終了するために必要な操作を返す。 */
export interface WhipPublisher {
  /** ローカルの RTCPeerConnection を同期的に閉じる。 */
  close(): void;
  /** WHIP resource の削除完了を待つ。 */
  deleteResource(): Promise<void>;
  /** ローカル接続を閉じ、WHIP resource の削除完了を待つ。 */
  stop(): Promise<void>;
  /** 同じ映像・配信 ID・最新 token で一度だけ publish し直す。 */
  republish(): Promise<WhipPublisher>;
  /** 延長で更新された publish token を以後の操作へ反映する。 */
  setPublishToken(publishToken: string): void;
  /**
   * 映像 outbound-rtp の送出統計を返す。閉じた pc やレポート無しでは null。
   * 閉じると getStats が空になるので、必ず close/republish の前に呼ぶこと。
   */
  videoStats(): Promise<VideoPublishStats | null>;
}

/** feature 側が決定し WHIP sender へ注入する映像設定。 */
export interface WhipVideoSettings {
  maxBitrate: number;
  contentHint: string;
  degradationPreference: RTCDegradationPreference;
  scaleResolutionDownBy?: number;
}

interface StartWhipPublisherInput {
  stream: MediaStream;
  whipUrl: string;
  publishToken: string;
  keyframeRequestIntervalMs?: typeof MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS;
  /** 呼び出し元が URL query から決めた音声プロファイル（既定は raw だが、省略は許さず明示させる）。 */
  audioProfile: AudioProfile;
  videoSettings: WhipVideoSettings;
  fetchImpl?: typeof fetch;
}

const ICE_GATHERING_TIMEOUT_MS = 15_000;

interface KeyframeRequestOptions {
  encodingOptions: Array<{ keyFrame: true }>;
}

interface KeyframeRequestSender {
  getParameters(): RTCRtpSendParameters;
  setParameters(parameters: RTCRtpSendParameters, options: KeyframeRequestOptions): Promise<void>;
}

interface KeyframeRequester {
  start(): void;
  stop(): void;
}

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
    await configureVideoSender(transceiver.sender, input.videoSettings);
    track.contentHint = input.videoSettings.contentHint;
    for (const audioTrack of input.stream.getAudioTracks()) {
      const audioSender = peerConnection.addTrack(audioTrack, input.stream);
      if (input.audioProfile === 'raw') await configureRawAudioSender(audioSender);
    }

    await peerConnection.setLocalDescription(await peerConnection.createOffer());
    await waitForIceGathering(peerConnection);
    const response = await publishOffer(peerConnection, input, input.fetchImpl ?? fetch);
    resourceUrl = response.resourceUrl;
    await peerConnection.setRemoteDescription({
      type: 'answer',
      sdp: input.audioProfile === 'raw' ? withRawAudioOpusParameters(response.answerSdp) : response.answerSdp,
    });
    const keyframeRequester = input.keyframeRequestIntervalMs === MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS
      ? createKeyframeRequester(transceiver.sender)
      : undefined;
    keyframeRequester?.start();
    return publisherFor(
      peerConnection,
      resourceUrl,
      input.publishToken,
      input.fetchImpl ?? fetch,
      input,
      keyframeRequester
    );
  } catch (error) {
    peerConnection.close();
    if (resourceUrl) {
      void deleteWhipResource(resourceUrl, input.publishToken, input.fetchImpl ?? fetch);
    }
    throw error;
  }
}

function videoCodecPreferences(): RTCRtpCodec[] | null {
  return prioritizeH264(RTCRtpSender.getCapabilities('video')?.codecs ?? []);
}

async function configureVideoSender(sender: RTCRtpSender, settings: WhipVideoSettings): Promise<void> {
  const parameters = sender.getParameters();
  parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
  parameters.encodings[0]!.maxBitrate = settings.maxBitrate;
  if (settings.scaleResolutionDownBy !== undefined) {
    parameters.encodings[0]!.scaleResolutionDownBy = settings.scaleResolutionDownBy;
  }
  parameters.degradationPreference = settings.degradationPreference;
  try {
    await sender.setParameters(parameters);
  } catch {
    const fallback = sender.getParameters();
    fallback.encodings = fallback.encodings?.length ? fallback.encodings : [{}];
    fallback.encodings[0]!.maxBitrate = settings.maxBitrate;
    delete fallback.encodings[0]!.scaleResolutionDownBy;
    delete fallback.degradationPreference;
    await sender.setParameters(fallback);
  }
}

function createKeyframeRequester(sender: RTCRtpSender): KeyframeRequester {
  const keyframeSender = sender as unknown as KeyframeRequestSender;
  let stopped = false;
  let started = false;
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;

  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) globalThis.clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (): void => {
    if (stopped) return;
    timer = globalThis.setTimeout(request, MP3_BETA_KEYFRAME_REQUEST_INTERVAL_MS);
  };
  const request = (): void => {
    timer = undefined;
    if (stopped) return;
    try {
      const parameters = keyframeSender.getParameters();
      const options: KeyframeRequestOptions = {
        encodingOptions: (parameters.encodings ?? []).map(() => ({ keyFrame: true })),
      };
      void keyframeSender.setParameters(parameters, options).then(schedule, stop);
    } catch {
      stop();
    }
  };
  return {
    start(): void {
      if (started || stopped) return;
      started = true;
      request();
    },
    stop,
  };
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
  const response = await fetchImpl(input.whipUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.publishToken}`,
      'Content-Type': 'application/sdp',
    },
    body: peerConnection.localDescription?.sdp,
  });
  if (response.status !== 201) throw new WhipPublishError('WHIP_REQUEST_FAILED');

  const location = response.headers.get('Location');
  const resourceUrl = location ? resolveWhipResourceUrl(location, input.whipUrl) : null;
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
  fetchImpl: typeof fetch,
  input: StartWhipPublisherInput,
  keyframeRequester?: KeyframeRequester
): WhipPublisher {
  let currentPublishToken = publishToken;
  let closed = false;
  let deletePromise: Promise<void> | null = null;
  let republishPromise: Promise<WhipPublisher> | null = null;
  const close = (): void => {
    if (closed) return;
    closed = true;
    keyframeRequester?.stop();
    peerConnection.close();
  };
  const deleteResource = (): Promise<void> => {
    if (!deletePromise) {
      deletePromise = fetchImpl(resourceUrl, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${currentPublishToken}` },
      }).then((response) => {
        if (!response.ok) throw new WhipPublishError('WHIP_REQUEST_FAILED');
      });
    }
    return deletePromise;
  };
  return {
    close,
    deleteResource,
    stop(): Promise<void> {
      close();
      return deleteResource();
    },
    republish(): Promise<WhipPublisher> {
      if (!republishPromise) {
        close();
        republishPromise = deleteResource().then(() =>
          startWhipPublisher({ ...input, publishToken: currentPublishToken, fetchImpl })
        );
      }
      return republishPromise;
    },
    setPublishToken(nextPublishToken: string): void {
      currentPublishToken = nextPublishToken;
    },
    async videoStats(): Promise<VideoPublishStats | null> {
      // 閉じた pc の getStats は空を返すので、close 済みなら観測不能として null。
      if (closed) return null;
      return readVideoPublishStats(peerConnection);
    },
  };
}

/**
 * 補助的な映像 codec（RTX 再送・RED・FEC）の mimeType。これらの outbound-rtp は
 * 本来の映像送出量ではないため no-video 判定から除外する
 * （手法は scripts/benchmark-screen-share-fps-core.ts の selectPrimaryH264VideoOutbound と同じ）。
 */
const AUXILIARY_VIDEO_CODECS = /^video\/(rtx|red|ulpfec|flexfec)/i;

/** codec レポート（type==='codec'）の mimeType を読むための最小形。lib.dom に型が無い。 */
interface CodecMimeStats {
  mimeType?: string;
}

/**
 * 映像 outbound-rtp レポートから送出量を取り出す。取得不能・レポート無しは null。
 *
 * Chrome は RTX（再送）の outbound-rtp を H.264 本体より先に返すことがあり、その
 * bytesSent:0 を拾うと no-video 誤判定になる。codecId→codec の mimeType を解決して
 * H.264 本体を選び、補助 codec を除外する。
 */
export async function readVideoPublishStats(
  peerConnection: RTCPeerConnection
): Promise<VideoPublishStats | null> {
  let report: RTCStatsReport;
  try {
    report = await peerConnection.getStats();
  } catch {
    return null;
  }

  const byId = new Map<string, RTCStats>();
  const videoOutbounds: RTCOutboundRtpStreamStats[] = [];
  for (const stat of report.values()) {
    byId.set(stat.id, stat);
    if (stat.type !== 'outbound-rtp') continue;
    // RTCStats に kind が無いため、outbound-rtp 判定後に映像レポート型へ絞る。
    const outbound = stat as RTCOutboundRtpStreamStats;
    if (outbound.kind === 'video') videoOutbounds.push(outbound);
  }
  if (videoOutbounds.length === 0) return null;

  const codecMime = (outbound: RTCOutboundRtpStreamStats): string | undefined => {
    if (!outbound.codecId) return undefined;
    // codec レポートは mimeType を持つ discriminant なのでその型へ絞る。
    return (byId.get(outbound.codecId) as CodecMimeStats | undefined)?.mimeType;
  };
  const nonAuxiliary = videoOutbounds.filter((outbound) => {
    const mimeType = codecMime(outbound);
    return mimeType === undefined || !AUXILIARY_VIDEO_CODECS.test(mimeType);
  });
  const candidates = nonAuxiliary.length > 0 ? nonAuxiliary : videoOutbounds;
  const h264 = candidates.find((outbound) => {
    const mimeType = codecMime(outbound);
    return mimeType !== undefined && /^video\/h264$/i.test(mimeType);
  });
  // H.264 本体が引けなければ bytesSent 最大の映像 outbound（undefined は 0 として比較のみ）。
  const selected = h264 ?? candidates.reduce((best, current) =>
    (current.bytesSent ?? 0) > (best.bytesSent ?? 0) ? current : best
  );
  return { bytesSent: selected.bytesSent, framesEncoded: selected.framesEncoded };
}
