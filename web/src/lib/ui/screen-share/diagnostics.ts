/**
 * 画面共有ライブ配信の失敗診断（純関数・DOM 非依存）。
 *
 * 2 つの関心事を controller から切り出す:
 * - classifyStreamFailure: 失敗の種別と映像統計から、匿名ログへ送る errorCode を決める。
 * - buildStreamDiagnosticSnapshot: ユーザーがコピーしてサポートへ渡すための構造化スナップショット。
 *
 * 匿名ログ（POST /api/client-error）へ送るのは classifyStreamFailure の結果（識別子）だけ。
 * getStats の数値・UA・stream id はスナップショット側にだけ載せ、クライアント内で完結させる。
 */

import type { ClientErrorCode } from '../../contracts/client-error';
import type { StreamHealthResponse } from '../../contracts/streams';
import type { VideoPublishStats } from '../whip-publisher';

/** 失敗の起点。どこで落ちたかで分類とスナップショットの読み方が変わる。 */
export type StreamFailureKind = 'displayDenied' | 'publishFailed' | 'healthTimeout';

export interface StreamFailureInput {
  kind: StreamFailureKind;
  stats: VideoPublishStats | null;
  health: StreamHealthResponse | null;
}

/**
 * 失敗種別と映像統計から、匿名ログへ送る errorCode を決める。
 *
 * healthTimeout の分岐は「映像が 1 バイトも出ていない（H.264 未生成）」のか
 * 「出ているのに health 未達」なのかを bytesSent で切り分ける。bytesSent を
 * 観測できない（Safari の framesEncoded 欠落・レポート無し）場合は no-video と
 * 断定せず statsUnavailable にする（誤って no-video と数えない）。
 */
export function classifyStreamFailure(input: StreamFailureInput): ClientErrorCode {
  if (input.kind === 'displayDenied') return 'streamDisplayDenied';
  if (input.kind === 'publishFailed') return 'streamPublishFailed';
  const bytesSent = input.stats?.bytesSent;
  if (bytesSent === 0) return 'streamNoVideo';
  if (typeof bytesSent === 'number') return 'streamHealthTimeout';
  return 'streamStatsUnavailable';
}

/** getVideoTracks()[0].getSettings() から診断に使う値だけを取り出したもの。 */
export interface DiagnosticVideoSettings {
  width: number | undefined;
  height: number | undefined;
  frameRate: number | undefined;
}

export interface StreamDiagnosticInput {
  /** 12 文字の配信 ID。journald の live/<id>・Cloudflare ログ・ユーザー申告を結ぶ唯一の鍵。 */
  streamId: string | null;
  at: string;
  userAgent: string;
  displaySurface: string | null;
  video: DiagnosticVideoSettings | null;
  stats: VideoPublishStats | null;
  health: StreamHealthResponse | null;
  failureCode: ClientErrorCode;
}

/**
 * サポートへ貼り付けられる構造化スナップショットを組み立てる。
 *
 * JSON.stringify 可能な素の値だけを載せる。匿名ログには送らず、コピーボタン経由で
 * ユーザーが明示的に共有するときだけ外へ出る。streamId は必ずキーを含める
 * （画面選択が拒否され配信が生まれなかった場合だけ null）。
 */
export function buildStreamDiagnosticSnapshot(input: StreamDiagnosticInput): Record<string, unknown> {
  return {
    streamId: input.streamId,
    at: input.at,
    userAgent: input.userAgent,
    displaySurface: input.displaySurface,
    video: input.video
      ? { width: input.video.width, height: input.video.height, frameRate: input.video.frameRate }
      : null,
    stats: input.stats
      ? { bytesSent: input.stats.bytesSent, framesEncoded: input.stats.framesEncoded }
      : null,
    health: input.health
      ? {
          state: input.health.state,
          ingressBytes: input.health.ingressBytes,
          egressBytes: input.health.egressBytes,
        }
      : null,
    failureCode: input.failureCode,
  };
}
