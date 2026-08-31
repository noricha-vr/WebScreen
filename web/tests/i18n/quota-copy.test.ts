import { describe, expect, test } from 'bun:test';

import en from '../../src/i18n/en.json';
import ja from '../../src/i18n/ja.json';
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

  // 利用規約は「ピン留めは 1 年」を約束として書いている。定数を変えた時に規約だけ古くなると、
  // 実挙動と規約の食い違いになるので LP と同じ理由でここに縛る。条項の並び順には依存させない。
  test.each([
    ['ja', ja, '1 年間'],
    ['en', en, 'one year'],
  ])('%s の利用規約がピン留めの保管期間を %s と書いている', (_locale, dictionary, expected) => {
    expect(PINNED_RETENTION_MS / MS_PER_DAY / 365).toBe(1);

    const terms = dictionary.terms.sections.flatMap((section) => section.body).join('\n');

    expect(terms).toContain(expected as string);
  });
});
