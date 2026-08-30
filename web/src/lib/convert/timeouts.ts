/**
 * クライアント側の長い待ちに期限と中止を与える。
 *
 * ブラウザ内変換は「変換エンジンの取得 → 画像の取得 → R2 への PUT」と待ちが続き、
 * どれか 1 つでも詰まると進捗バーが止まったまま永久に返らない。段ごとに期限を切り、
 * 期限切れは段の分かる表示コード（StageTimeoutError.code）で投げる。
 *
 * 利用者による中止は失敗ではないので期限切れと区別し、そのまま伝播させる
 * （呼び出し側が idle へ戻す）。
 */

/**
 * 変換エンジン（ffmpeg core / wasm、数十 MB）の取得と初期化の上限。
 * CDN が詰まった時の待ちであり、細い回線でも数十 MB を引き切れる幅を残す。
 */
export const WASM_LOAD_TIMEOUT_MS = 60_000;
/**
 * 撮影済み画像 1 枚あたりの取得上限。枚数分だけ直列に積み上がるため 1 枚は短く切る。
 * note: 逐次取得のままなので長いページほど総待ち時間が伸びる。並列化は Issue #71。
 */
export const IMAGE_FETCH_TIMEOUT_MS = 30_000;
/** R2 への PUT の上限。上限 50 MB を細い回線で送り切る余地を残す。 */
export const UPLOAD_PUT_TIMEOUT_MS = 120_000;

/** 期限切れの段。UI の表示コードとしてそのまま辞書を引く。 */
export const STAGE_TIMEOUT_CODES = ['wasmLoadTimeout', 'imageFetchTimeout', 'uploadTimeout'] as const;
export type StageTimeoutCode = (typeof STAGE_TIMEOUT_CODES)[number];

/** 段ごとの期限切れ。原因の分かる文言を出すため、段を code として持ち回る。 */
export class StageTimeoutError extends Error {
  constructor(readonly code: StageTimeoutCode) {
    super(`Stage timed out: ${code}`);
    this.name = 'StageTimeoutError';
  }
}

/** 利用者の中止で落ちたかどうか。失敗表示とリセットの分岐に使う。 */
export function isUserAborted(userSignal?: AbortSignal): boolean {
  return userSignal?.aborted === true;
}

/** シグナルが落ちた時に、その理由で reject するだけの promise。 */
export function abortRejection(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

/**
 * 期限と利用者の中止を束ねたシグナルを run へ渡す。
 *
 * 失敗の分類はエラーの名前ではなくシグナルの状態で行う。ffmpeg の worker を
 * terminate() して待ちを解いた場合、reject されるのは AbortError ではなく
 * ライブラリ独自のエラーになるため、名前で見ると中止が「変換失敗」に化ける。
 */
export async function withStageTimeout<T>(
  code: StageTimeoutCode,
  timeoutMs: number,
  userSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = userSignal ? AbortSignal.any([timeout, userSignal]) : timeout;
  try {
    return await run(signal);
  } catch (error) {
    if (isUserAborted(userSignal)) throw error;
    if (timeout.aborted) throw new StageTimeoutError(code);
    throw error;
  }
}
