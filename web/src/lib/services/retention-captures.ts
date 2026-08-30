/**
 * captures/ 配下の中間生成物の掃除。
 *
 * 動画化が終われば不要になる R2 だけの掃除で、D1 の行とは対応しない
 * （retention.ts の movies の掃除と違い、片落ちの不整合が起きない）。
 * 必要な操作面もこの層で完結するため、独立したモジュールに置く。
 */

/** 掃除が見るオブジェクト（キーとアップロード時刻だけ）。 */
export interface CaptureObject {
  key: string;
  uploaded: Date;
}

export interface CaptureListResult {
  objects: CaptureObject[];
  truncated: boolean;
  cursor?: string;
}

/** captures の掃除が使う R2 の最小操作面。 */
export interface CaptureBucket {
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<CaptureListResult>;
}

/** captures/ の中間生成物を残す期間。動画化が終われば不要になる。 */
const CAPTURE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * 1 回の実行で削除するキャプチャの上限。R2 の list / delete は subrequest を
 * 消費するため、1 回で消し切ろうとせず毎時の実行で分割して処理する。
 */
export const MAX_CAPTURE_DELETIONS_PER_RUN = 1000;

/**
 * キャプチャの R2 prefix。キー規則の正本は contracts/r2key.ts の captureKey で、
 * ここは list 用の prefix だけを持つ（一致は retention のテストで検証する）。
 */
export const CAPTURE_KEY_PREFIX = 'captures/';

/**
 * captures/ 配下の古い中間生成物を削除する。
 *
 * list は 1 ページずつ辿り、削除は上限に達した時点で打ち切る。残りは次回の
 * 実行が同じ条件で拾うため、取りこぼしにはならない。
 */
export async function deleteStaleCaptures(bucket: CaptureBucket, now: Date): Promise<number> {
  const threshold = now.getTime() - CAPTURE_RETENTION_MS;
  let cursor: string | undefined;
  let deleted = 0;

  while (deleted < MAX_CAPTURE_DELETIONS_PER_RUN) {
    const page: CaptureListResult = await bucket.list(
      cursor === undefined
        ? { prefix: CAPTURE_KEY_PREFIX }
        : { prefix: CAPTURE_KEY_PREFIX, cursor }
    );

    const stale = page.objects
      .filter((object) => object.uploaded.getTime() < threshold)
      .map((object) => object.key)
      .slice(0, MAX_CAPTURE_DELETIONS_PER_RUN - deleted);

    if (stale.length > 0) {
      await bucket.delete(stale);
      deleted += stale.length;
    }

    if (!page.truncated || page.cursor === undefined) break;
    cursor = page.cursor;
  }

  return deleted;
}
