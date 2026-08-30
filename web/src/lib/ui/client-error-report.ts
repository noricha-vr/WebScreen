/**
 * クライアント側の失敗を `POST /api/client-error/` へ投げっぱなしで報告する。
 *
 * 目的は運用側が「どの段で落ちたか」を数えられるようにすること。したがって
 * **送るのは識別子だけ**で、URL・ファイル名・ページ内容・例外メッセージ・
 * スタックトレースは一切載せない（受信側の allowlist と二重の歯止めにする）。
 *
 * 送信は必ず fire-and-forget。ここでの失敗を UI に伝播させない（テレメトリのために
 * 利用者の画面が壊れるのは本末転倒）。
 *
 * 送信頻度の上限もここで持つ。失敗はループしやすく（再試行・連続アップロード）、
 * 素直に送ると 1 回の事故で数百件のリクエストが飛ぶため。サーバー側での
 * レート制限は置かない（必要になったら Cloudflare の Rate Limiting Rule で絞る）。
 */

import {
  isClientErrorCode,
  type ClientErrorCode,
  type ClientErrorReport,
  type ClientErrorStage,
} from '../contracts/client-error';
import { JsonRequestError } from './request-json';
import type { ProgressStage } from './upload-flow';

/** trailingSlash: 'always' のためスラッシュ必須。省くと 301 を挟む。 */
export const CLIENT_ERROR_ENDPOINT = '/api/client-error/';

/** 同じ「段 + コード」の組を 1 ページ表示につき送る上限。 */
export const CLIENT_ERROR_MAX_PER_KEY = 5;

/** 送信間隔の下限（ミリ秒）。組を問わず、この間隔より詰めては送らない。 */
export const CLIENT_ERROR_MIN_INTERVAL_MS = 1000;

/** 送信済みの記録。ページを読み直せば初期化される（サーバーに状態を持たせない）。 */
export interface ClientErrorThrottle {
  readonly counts: Readonly<Record<string, number>>;
  readonly lastSentAtMs: number | null;
}

export const INITIAL_CLIENT_ERROR_THROTTLE: ClientErrorThrottle = {
  counts: {},
  lastSentAtMs: null,
};

function throttleKey(report: ClientErrorReport): string {
  return `${report.stage}:${report.errorCode}`;
}

/**
 * 送ってよいかを判定し、次の記録を返す純関数。
 *
 * 却下した報告は数えない（数えると、上限に達した後の失敗が延々と記録を更新して
 * 「いつまでも送れない」状態になる）。
 */
export function admitClientError(
  state: ClientErrorThrottle,
  report: ClientErrorReport,
  nowMs: number
): { admitted: boolean; state: ClientErrorThrottle } {
  const key = throttleKey(report);
  const sent = state.counts[key] ?? 0;
  if (sent >= CLIENT_ERROR_MAX_PER_KEY) return { admitted: false, state };
  if (state.lastSentAtMs !== null && nowMs - state.lastSentAtMs < CLIENT_ERROR_MIN_INTERVAL_MS) {
    return { admitted: false, state };
  }

  return {
    admitted: true,
    state: { counts: { ...state.counts, [key]: sent + 1 }, lastSentAtMs: nowMs },
  };
}

/**
 * 送信する本文を組み立てる。
 *
 * スプレッドで作らないのは、呼び出し側が余分なフィールドを持つ値を渡しても
 * 混入させないため（テストでキーの集合を固定している）。
 */
export function clientErrorPayload(report: ClientErrorReport): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    stage: report.stage,
    errorCode: report.errorCode,
  };
  if (report.httpStatus !== undefined) payload['httpStatus'] = report.httpStatus;
  return payload;
}

/**
 * 失敗の値から報告コードを決める。
 *
 * サーバー応答の errorCode をそのまま転送しない。allowlist に無い値は 'failed' に
 * 丸める（応答本文が汚染されていても、送るのは既知の識別子だけに保つ）。
 */
export function clientErrorCodeOf(error: unknown, fallback: ClientErrorCode = 'failed'): ClientErrorCode {
  if (error instanceof JsonRequestError && error.errorCode && isClientErrorCode(error.errorCode)) {
    return error.errorCode;
  }
  return fallback;
}

/** HTTP 応答由来の失敗ならステータスを返す。ブラウザ内の失敗では undefined。 */
export function clientErrorHttpStatus(error: unknown): number | undefined {
  return error instanceof JsonRequestError ? error.status : undefined;
}

/** 変換の進捗段階を、報告する段へ落とす。段が未定のうちの失敗は変換扱いにする。 */
export function conversionClientStage(stage: ProgressStage | null): ClientErrorStage {
  if (stage === 'capturing') return 'capture';
  if (stage === 'uploading') return 'upload';
  return 'convert';
}

export interface ClientErrorReporterDeps {
  /** 実送信。テストと SSR での差し替え口。 */
  send?: (body: string) => void;
  now?: () => number;
}

/**
 * 上限つきの報告関数を作る。状態は返した関数のクロージャに閉じる
 * （モジュール全体で共有すると、テストが互いの送信回数に影響される）。
 */
export function createClientErrorReporter(
  deps: ClientErrorReporterDeps = {}
): (report: ClientErrorReport) => void {
  const send = deps.send ?? sendClientErrorReport;
  const now = deps.now ?? (() => Date.now());
  let throttle = INITIAL_CLIENT_ERROR_THROTTLE;

  return (report) => {
    try {
      const decision = admitClientError(throttle, report, now());
      throttle = decision.state;
      if (!decision.admitted) return;
      send(JSON.stringify(clientErrorPayload(report)));
    } catch {
      // 報告できないこと自体は利用者に関係がない。画面の失敗表示を優先する。
    }
  };
}

/** sendBeacon を優先する（離脱直前でも送るため）。使えない環境では keepalive の fetch に落とす。 */
function sendClientErrorReport(body: string): void {
  const beacon = typeof navigator !== 'undefined' ? navigator.sendBeacon?.bind(navigator) : undefined;
  if (beacon && beacon(CLIENT_ERROR_ENDPOINT, new Blob([body], { type: 'application/json' }))) {
    return;
  }

  void fetch(CLIENT_ERROR_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
    credentials: 'same-origin',
  }).catch(() => undefined);
}

/** 画面から使う既定の報告関数。1 ページ表示ぶんの上限を共有する。 */
export const reportClientError = createClientErrorReporter();

/** HTTP 要求の失敗を 1 行で報告する。送るのは段・allowlist を通したコード・ステータスだけ。 */
export function reportRequestFailure(stage: ClientErrorStage, error: unknown): void {
  reportClientError({
    stage,
    errorCode: clientErrorCodeOf(error),
    httpStatus: clientErrorHttpStatus(error),
  });
}
