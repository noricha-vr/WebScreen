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
 * 撮影済み画像 1 枚あたりの取得上限。期限は 1 枚ごとに切り直す。
 *
 * 取得は数本ずつ並行して走る（IMAGE_FETCH_CONCURRENCY）ので、合計の待ちは枚数 ÷ 同時数に近づく。
 * ただし副作用として、同時に走る数本が帯域を分け合うぶん 1 枚あたりの所要は逐次のときより伸びる。
 * 細い回線ほど効き、逐次なら間に合っていた 1 枚が期限に触れうるので、逐次時代の 30 秒から広げた。
 * 同時数と釣り合う 30 × 6 秒まで伸ばすと、本当に詰まったときの見切りが遅くなりすぎるため採らない。
 * ここに触れる報告が続くなら、期限ではなく IMAGE_FETCH_CONCURRENCY を下げる。
 */
export const IMAGE_FETCH_TIMEOUT_MS = 45_000;
/** R2 への PUT の上限。上限 50 MB を細い回線で送り切る余地を残す。 */
export const UPLOAD_PUT_TIMEOUT_MS = 120_000;
/**
 * presign / commit のような短い JSON 要求の上限。
 * これらは利用者の中止では打ち切らない（予約済みの行を宙に浮かせないため）ので、
 * 詰まったときに抜ける手段は期限だけになる。
 */
export const API_REQUEST_TIMEOUT_MS = 30_000;

/**
 * 期限切れの段。UI の表示コードとしてそのまま辞書を引く。
 *
 * apiTimeout（予約・確定の要求）と uploadTimeout（本体の送信）は分ける。前者はまだ 1 バイトも
 * 送っていないので、利用者に伝えるべきことが違う。
 */
export const STAGE_TIMEOUT_CODES = [
  'wasmLoadTimeout',
  'imageFetchTimeout',
  'uploadTimeout',
  'apiTimeout',
] as const;
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

/**
 * 中止時に stop を呼ぶ。戻り値は解除関数。
 *
 * 既に落ちているシグナルへ addEventListener しても 'abort' は二度と発火しないため、
 * その場合はその場で stop を呼ぶ。ここを取り違えると「中止済みなのに止まらない」になる。
 */
export function onAbort(signal: AbortSignal | undefined, stop: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    stop();
    return () => {};
  }
  signal.addEventListener('abort', stop, { once: true });
  return () => signal.removeEventListener('abort', stop);
}

/**
 * シグナルを受け取れない処理（ffmpeg の load / exec）を中止と競わせる。
 *
 * 決着したら abort リスナーを必ず外す。外さないと、同じシグナルを使い回す
 * 呼び出しのぶんだけ listener が積み上がる。
 */
export async function raceAbort<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;

  let removeAbortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        const rejectOnAbort = (): void => reject(signal.reason);
        removeAbortListener = (): void => signal.removeEventListener('abort', rejectOnAbort);
        signal.addEventListener('abort', rejectOnAbort, { once: true });
      }),
    ]);
  } finally {
    removeAbortListener?.();
  }
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
