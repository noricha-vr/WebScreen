import { describe, expect, test } from 'bun:test';

import {
  formatRelativeTime,
  movieEndpoint,
  parseHistoryEntries,
  pinEndpoint,
  remainingDays,
} from '../../src/lib/ui/history-view';

const NOW = new Date('2026-08-25T12:00:00.000Z');

function entry(overrides: Record<string, unknown> = {}) {
  return {
    shortId: 'AbCdEf123456',
    filename: 'slides.pdf',
    status: 'ready',
    pinned: false,
    createdAt: '2026-08-25T11:00:00.000Z',
    expiresAt: '2026-09-24T11:00:00.000Z',
    publicUrl: 'https://public.example/movies/AbCdEf123456.mp4',
    ...overrides,
  };
}

describe('parseHistoryEntries', () => {
  test('正常な応答をそのまま読み取る', () => {
    expect(parseHistoryEntries({ movies: [entry({ pinned: true })] })).toEqual({
      entries: [
        {
          shortId: 'AbCdEf123456',
          filename: 'slides.pdf',
          status: 'ready',
          pinned: true,
          createdAt: '2026-08-25T11:00:00.000Z',
          expiresAt: '2026-09-24T11:00:00.000Z',
          publicUrl: 'https://public.example/movies/AbCdEf123456.mp4',
        },
      ],
      dropped: 0,
      malformed: false,
    });
  });

  test('読めなかった行数を数える', () => {
    const result = parseHistoryEntries({
      movies: [entry({ filename: 123 }), entry({ status: 'unknown' }), null, entry()],
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.shortId).toBe('AbCdEf123456');
    expect(result.dropped).toBe(3);
    expect(result.malformed).toBe(false);
  });

  test('pin されていない動画の expiresAt は残す', () => {
    expect(
      parseHistoryEntries({ movies: [entry({ expiresAt: null })] }).entries[0]?.expiresAt
    ).toBeNull();
  });

  test.each([[null], [{}], [{ movies: 'x' }], [[]]])('%p は契約違反として印を付ける', (payload) => {
    expect(parseHistoryEntries(payload)).toEqual({ entries: [], dropped: 0, malformed: true });
  });

  test('0 件の応答は契約違反ではない', () => {
    expect(parseHistoryEntries({ movies: [] })).toEqual({
      entries: [],
      dropped: 0,
      malformed: false,
    });
  });
});

describe('formatRelativeTime', () => {
  test.each([
    ['2026-08-25T11:59:30.000Z', 'ja', '今'],
    ['2026-08-25T11:57:00.000Z', 'ja', '3 分前'],
    ['2026-08-25T09:00:00.000Z', 'ja', '3 時間前'],
    ['2026-08-23T12:00:00.000Z', 'ja', '一昨日'],
    ['2026-05-25T12:00:00.000Z', 'ja', '3 か月前'],
    ['2026-08-25T11:57:00.000Z', 'en', '3 minutes ago'],
  ])('%s (%s) → %s', (isoDate, locale, expected) => {
    expect(formatRelativeTime(isoDate as string, NOW, locale as string)).toBe(expected as string);
  });

  test('解釈できない日時は空文字', () => {
    expect(formatRelativeTime('not-a-date', NOW, 'ja')).toBe('');
  });
});

describe('remainingDays', () => {
  test.each([
    ['2026-09-24T12:00:00.000Z', 30],
    // 24 時間未満でも「あと 1 日」と出す（0 日と表示しない）
    ['2026-08-26T02:00:00.000Z', 1],
    ['2026-08-24T12:00:00.000Z', 0],
    ['not-a-date', 0],
  ])('%s → %i 日', (expiresAt, expected) => {
    expect(remainingDays(expiresAt as string, NOW)).toBe(expected as number);
  });
});

describe('エンドポイント', () => {
  test('shortId をパスに埋めた URL を組み立てる', () => {
    expect(movieEndpoint('AbCdEf123456')).toBe('/api/movies/AbCdEf123456/');
    expect(pinEndpoint('AbCdEf123456')).toBe('/api/movies/AbCdEf123456/pin/');
  });

  test('想定外の文字はエスケープしてパスを壊さない', () => {
    expect(movieEndpoint('../secret')).toBe('/api/movies/..%2Fsecret/');
  });
});
