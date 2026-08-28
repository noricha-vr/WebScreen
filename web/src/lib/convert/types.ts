/** ブラウザ内変換で使う正規化済み PNG フレーム。 */
export interface VideoFrame {
  /** エンコーダへ渡す PNG バイト列。 */
  data: Uint8Array;
  /** 全フレームで統一する偶数幅。 */
  width: number;
  /** 全フレームで統一する偶数高さ。 */
  height: number;
}

/**
 * 変換工程の段階。UI は段階ごとに進捗バーの帯域を割り当てるため、
 * どの工程の進捗かを進捗そのものと一緒に受け取る必要がある。
 * 撮影・アップロードは convert の外側の工程なのでここには含めない。
 */
export type ConversionStage = 'preparing' | 'encoding';

/** 変換工程から UI へ返す進捗。 */
export interface ConversionProgress {
  /** どの工程の進捗か。% と枚数を同じ段階のものへ揃えるために必須。 */
  stage: ConversionStage;
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
