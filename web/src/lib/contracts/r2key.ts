/**
 * R2 のオブジェクトキー導出と shortId 生成。
 *
 * キーの組み立てを 1 箇所に集約し、アップロード側（Worker）と参照側
 * （公開 URL 生成・削除バッチ・web-capture）が同じ規則で導出できるようにする。
 * 文字列連結をハンドラ側で書かないこと。
 */

/** shortId の文字集合（base62）。URL に現れるので記号を含めない。 */
export const SHORT_ID_ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * shortId の長さ。62^12 ≈ 3.2e21 で、公開 URL の総当たり探索を実質不能にする
 * （動画 URL は公開のままなので、推測困難性そのものが保護になる）。
 */
export const SHORT_ID_LENGTH = 12;

const SHORT_ID_PATTERN = /^[0-9A-Za-z]{12}$/;

/**
 * 棄却サンプリングの境界。256 を 62 で割った余り（256 % 62 = 8）の分だけ
 * 末尾のバイト値が余分に特定の文字へ写るため、62 の倍数の最大値 248 以上は捨てる。
 * これを省くと 0〜7 に対応する文字だけ出現確率が約 1.6 倍になる。
 */
const REJECTION_THRESHOLD = 248; // 62 * 4

/** 乱数供給。テストで決定的なバイト列を注入できるように差し替え可能にする。 */
export type RandomFill = (bytes: Uint8Array<ArrayBuffer>) => void;

const defaultRandomFill: RandomFill = (bytes) => {
  crypto.getRandomValues(bytes);
};

/** 12 文字 base62 の shortId を生成する（モジュラーバイアスなし）。 */
export function generateShortId(randomFill: RandomFill = defaultRandomFill): string {
  let result = '';

  while (result.length < SHORT_ID_LENGTH) {
    const bytes = new Uint8Array(SHORT_ID_LENGTH - result.length);
    randomFill(bytes);

    for (const byte of bytes) {
      if (byte >= REJECTION_THRESHOLD) continue;
      result += SHORT_ID_ALPHABET[byte % SHORT_ID_ALPHABET.length];
      if (result.length === SHORT_ID_LENGTH) break;
    }
  }

  return result;
}

/** 12 文字 base62 の shortId 形式かを判定する。 */
export function isShortId(value: string): boolean {
  return SHORT_ID_PATTERN.test(value);
}

/** 完成した mp4 の R2 キー。 */
export function movieKey(shortId: string): string {
  if (!isShortId(shortId)) {
    throw new Error(`movieKey: shortId の形式が不正です (length=${shortId.length})`);
  }
  return `movies/${shortId}.mp4`;
}

/**
 * 完成した mp4 の公開 URL。配信元（R2_PUBLIC_BASE_URL）とキー規則をここで結ぶ。
 *
 * 表示（履歴・プレビュー）と削除時のキャッシュ purge が同じ文字列を組み立てられること
 * が要件。purge は URL の完全一致でしか効かないため、組み立てが 1 文字でもずれると
 * 「消したのに配信され続ける」に戻る。
 */
export function movieUrl(publicBaseUrl: string, shortId: string): string {
  return new URL(movieKey(shortId), `${publicBaseUrl}/`).toString();
}

/** captureKey の index 上限（0 埋め 4 桁で表現できる範囲）。 */
export const MAX_CAPTURE_INDEX = 9999;

const CAPTURE_INDEX_DIGITS = 4;
const CAPTURE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * キャプチャの拡張子。どちらを書くかは web-capture 側の設定で決まる
 * （撮影を速くするため JPEG へ移行中。移行の前後どちらでも WebScreen が壊れないよう両方を受理する）。
 */
export type CaptureExtension = 'png' | 'jpg';

/**
 * web-capture が撮ったスクリーンショットの R2 キー。
 *
 * index は 0 埋め 4 桁にする。R2 の list は辞書順で返るため、0 埋めしないと
 * "10" が "2" より前に並び、スクロール動画のコマ順が破綻する
 * （並び順の契約は contracts/api.ts の CaptureResponse.images と対で守る）。
 *
 * 既定を png のままにしてあるのは、web-capture の切り替えより先にこちらを本番へ出すため。
 * 上流が jpg へ切り替わっても取り込み（fetch → createImageBitmap）と掃除（captures/ prefix）は
 * 拡張子を見ないので、既定値は表示・記録上の意味しか持たない。
 */
export function captureKey(
  sessionId: string,
  index: number,
  extension: CaptureExtension = 'png'
): string {
  if (!CAPTURE_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('captureKey: sessionId は小文字の UUID である必要があります');
  }
  if (!Number.isInteger(index) || index < 0 || index > MAX_CAPTURE_INDEX) {
    throw new Error(`captureKey: index は 0〜${MAX_CAPTURE_INDEX} の整数である必要があります`);
  }
  return `captures/${sessionId}/${String(index).padStart(CAPTURE_INDEX_DIGITS, '0')}.${extension}`;
}
