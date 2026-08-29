import { describe, expect, test } from 'bun:test';

import { PINNED_RETENTION_MS } from '../../src/lib/services/quota';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * LP のピン留めカード（PinHighlight.astro）は「1 年」を文言側に固定で持っている。
 * 日数から「1 年」という表記を機械的には導けないため、定数を変えたらここで気づけるようにする。
 *
 * 通常の保管期間と件数はプレースホルダ経由で定数から流し込んでいるので、ここでは見ない。
 */
describe('保管期間の文言が前提にしている定数', () => {
  test('ピン留めの保管期間が 365 日である（LP の「1 年」表記の根拠）', () => {
    expect(PINNED_RETENTION_MS / MS_PER_DAY).toBe(365);
  });
});
