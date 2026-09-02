import { hasSingleExactQueryValue } from './stream-profile';

/** 画面取得〜送出までの音声の扱い。'legacy' は Chrome の音声処理に任せた旧挙動。 */
export type AudioProfile = 'raw' | 'legacy';

export const RAW_AUDIO_MAX_BITRATE = 128_000;

const RAW_AUDIO_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
} as const satisfies MediaTrackConstraints;

/**
 * URL query から音声プロファイルを決める。既定は raw。
 * 2026-09-02 の本番 A/B で、旧挙動は出口の L−R が −91 dB（完全モノラル）だったのに対し
 * raw は −57.6 dB でステレオ成分が残り、実聴でもステレオだったため raw を既定にした。
 * `audio-profile=legacy` が重複なく1個ある時だけ旧挙動へ戻す（切り分け用の退避経路）。
 */
export function resolveAudioProfileForSearch(search: string): AudioProfile {
  return hasSingleExactQueryValue(search, 'audio-profile', 'legacy') ? 'legacy' : 'raw';
}

/** 音声プロファイルに応じた画面共有の音声制約を返す。 */
export function displayAudioConstraint(profile: AudioProfile): boolean | MediaTrackConstraints {
  return profile === 'raw' ? { ...RAW_AUDIO_CONSTRAINTS } : true;
}

/**
 * 取得済み音声トラックの設定を raw・legacy の両方でログに残し（A/B で並べて比較するため）、
 * raw の時だけ contentHint を 'music' にして音声向けの処理を避ける。
 */
export function configureCaptureAudioTracks(media: MediaStream, profile: AudioProfile): void {
  for (const track of media.getAudioTracks()) {
    if (profile === 'raw') track.contentHint = 'music';
    const settings = track.getSettings();
    console.info('audio_capture_settings', {
      event: 'audio_capture_settings',
      profile,
      channelCount: settings.channelCount,
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
      sampleRate: settings.sampleRate,
    });
  }
}

/** raw 音声プロファイル向けに、audio sender の送出上限をベストエフォートで設定する。 */
export async function configureRawAudioSender(sender: RTCRtpSender): Promise<void> {
  try {
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0]!.maxBitrate = RAW_AUDIO_MAX_BITRATE;
    await sender.setParameters(parameters);
  } catch (error) {
    console.warn('raw_audio_sender_bitrate_failed', {
      event: 'raw_audio_sender_bitrate_failed',
      maxBitrate: RAW_AUDIO_MAX_BITRATE,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Opus の fmtp 行へ raw 音声プロファイル用のパラメータを補完する。 */
export function withRawAudioOpusParameters(answerSdp: string): string {
  const lineEnding = answerSdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = answerSdp.split(lineEnding);
  const opusPayloadTypes = new Set<string>();
  const fmtpPayloadTypes = new Set<string>();

  for (const line of lines) {
    const rtpmap = /^a=rtpmap:(\d+)\s+opus\/\d+(?:\/\d+)?\s*$/i.exec(line);
    if (rtpmap) opusPayloadTypes.add(rtpmap[1]!);
    const fmtp = /^a=fmtp:(\d+)(?:\s|$)/i.exec(line);
    if (fmtp) fmtpPayloadTypes.add(fmtp[1]!);
  }
  if (opusPayloadTypes.size === 0) return answerSdp;

  return lines.flatMap((line) => {
    const rtpmap = /^a=rtpmap:(\d+)\s+opus\/\d+(?:\/\d+)?\s*$/i.exec(line);
    if (rtpmap && !fmtpPayloadTypes.has(rtpmap[1]!)) {
      return [line, `a=fmtp:${rtpmap[1]} ${rawAudioOpusParameters('')}`];
    }

    const fmtp = /^a=fmtp:(\d+)\s*(.*)$/i.exec(line);
    if (fmtp && opusPayloadTypes.has(fmtp[1]!)) {
      return [`a=fmtp:${fmtp[1]} ${rawAudioOpusParameters(fmtp[2] ?? '')}`];
    }
    return [line];
  }).join(lineEnding);
}

function rawAudioOpusParameters(existingParameters: string): string {
  const requiredParameters = [
    'stereo=1',
    'sprop-stereo=1',
    `maxaveragebitrate=${RAW_AUDIO_MAX_BITRATE}`,
  ];
  const requiredNames = new Set(requiredParameters.map((parameter) => parameter.split('=')[0]!));
  const preserved = existingParameters.split(';').map((parameter) => parameter.trim()).filter((parameter) => {
    if (!parameter) return false;
    return !requiredNames.has(parameter.split('=', 1)[0]!.trim().toLowerCase());
  });
  return [...preserved, ...requiredParameters].join(';');
}
