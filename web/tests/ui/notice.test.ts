import { describe, expect, test } from 'bun:test';

import { isNoticeExpired, mountNotice, type NoticeElement } from '../../src/lib/ui/notice';

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

describe('mountNotice', () => {
  /** `data-notice-until` 付きの要素を模す（触るのは dataset と hidden だけ）。 */
  function element(until?: string): NoticeElement {
    return { dataset: until === undefined ? {} : { noticeUntil: until }, hidden: false };
  }

  test('期限前は表示したままにする', () => {
    const notice = element(UNTIL);
    mountNotice(notice, new Date('2026-10-30T12:00:00Z'));
    expect(notice.hidden).toBe(false);
  });

  test('期限を過ぎたら隠す', () => {
    const notice = element(UNTIL);
    mountNotice(notice, new Date('2026-11-01T00:00:00Z'));
    expect(notice.hidden).toBe(true);
  });

  test('data-notice-until が無い要素には触らない', () => {
    const notice = element();
    mountNotice(notice, new Date('2030-01-01T00:00:00Z'));
    expect(notice.hidden).toBe(false);
  });

  test('期限前なら隠れていた要素も表示に戻す（毎回判定し直す）', () => {
    const notice: NoticeElement = { dataset: { noticeUntil: UNTIL }, hidden: true };
    mountNotice(notice, new Date('2026-10-30T12:00:00Z'));
    expect(notice.hidden).toBe(false);
  });
});
