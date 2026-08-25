import { describe, expect, test } from 'bun:test';

import { parseViewer, viewerInitial } from '../../src/lib/ui/viewer';

describe('parseViewer', () => {
  test('name と avatarUrl を取り出す', () => {
    expect(parseViewer({ name: 'noricha', avatarUrl: 'https://cdn.example.com/a.png' })).toEqual({
      name: 'noricha',
      avatarUrl: 'https://cdn.example.com/a.png',
    });
  });

  test('user でネストされていても読める', () => {
    expect(parseViewer({ user: { username: 'noricha' } })).toEqual({
      name: 'noricha',
      avatarUrl: null,
    });
  });

  test('Discord ID と avatar hash から CDN URL を組み立てる', () => {
    expect(parseViewer({ name: 'noricha', discordId: '1234', avatar: 'a1b2c3d4' }).avatarUrl).toBe(
      'https://cdn.discordapp.com/avatars/1234/a1b2c3d4.png'
    );
  });

  test('Discord ID がない avatar hash は採用しない', () => {
    expect(parseViewer({ name: 'noricha', avatar: 'a1b2c3d4' }).avatarUrl).toBeNull();
  });

  test('payload が壊れていても画面が壊れない値を返す', () => {
    expect(parseViewer(null)).toEqual({ name: null, avatarUrl: null });
    expect(parseViewer('unexpected')).toEqual({ name: null, avatarUrl: null });
    expect(parseViewer({ name: '   ' }).name).toBeNull();
  });
});

describe('viewerInitial', () => {
  test('表示名の頭文字を大文字で返す', () => {
    expect(viewerInitial({ name: 'noricha', avatarUrl: null })).toBe('N');
  });

  test('表示名が無いときはサービス名の頭文字にフォールバックする', () => {
    expect(viewerInitial({ name: null, avatarUrl: null })).toBe('W');
  });
});
