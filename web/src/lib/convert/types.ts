/** ブラウザ内変換で使う正規化済み PNG フレーム。 */
export interface VideoFrame {
  /** エンコーダへ渡す PNG バイト列。 */
  data: Uint8Array;
  /** 全フレームで統一する偶数幅。 */
  width: number;
  /** 全フレームで統一する偶数高さ。 */
  height: number;
}

/** 変換工程から UI へ返す進捗。 */
export interface ConversionProgress {
  current: number;
  total: number;
}

/** 変換工程で利用する進捗通知。 */
export type ProgressReporter = (progress: ConversionProgress) => void;

/** 利用者へ表示するための変換失敗種別。 */
export type ConversionErrorCode = 'tooManyPages' | 'failed';

/** 変換失敗を UI のエラーコードへ正規化する。 */
export class ConversionError extends Error {
  constructor(
    public readonly code: ConversionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ConversionError';
  }
}
