import { describe, expect, test } from 'bun:test';

import { isNoticeExpired } from '../../src/lib/ui/notice';

/** 実行環境のタイムゾーンで結果が変わらないよう、時刻は必ず UTC で組み立てる。 */
const UNTIL = '2026-10-31';

describe('isNoticeExpired', () => {
  test('期限前は表示したままにする', () => {
    expect(isNoticeExpired(UNTIL, new Date('2026-10-30T12:00:00Z'))).toBe(false);
  });

  test('期限当日は日付が変わるまで表示する', () => {
    expect(isNoticeExpired(UNTIL, new Date('2026-10-31T23:59:59Z'))).toBe(false);
  });

  test('翌日 0 時からは期限切れにする', () => {
    expect(isNoticeExpired(UNTIL, new Date('2026-11-01T00:00:00Z'))).toBe(true);
  });

  test('日付として読めない値は期限切れにしない', () => {
    const now = new Date('2030-01-01T00:00:00Z');
    expect(isNoticeExpired('2026/10/31', now)).toBe(false);
    expect(isNoticeExpired('2026-13-45', now)).toBe(false);
    expect(isNoticeExpired('', now)).toBe(false);
  });
});
