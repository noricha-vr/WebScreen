import { describe, expect, test } from 'bun:test';

import en from '../../src/i18n/en.json';
import ja from '../../src/i18n/ja.json';
import {
  DEFAULT_LOCALE,
  LOCALES,
  alternateLocale,
  resolveLocale,
  switchLocalePath,
  useTranslations,
} from '../../src/i18n';

/** ネストしたキーを `a.b.c` 形式で平坦化する（配列は要素数まで見る）。 */
function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => keyPaths(item, `${prefix}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) =>
      keyPaths(child, prefix ? `${prefix}.${key}` : key)
    );
  }
  return [prefix];
}

/** 末端の文字列だけを集める。 */
function leafValues(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(leafValues);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(leafValues);
  return [];
}

describe('辞書', () => {
  test('ja と en のキー構成が一致する', () => {
    expect(keyPaths(en).sort()).toEqual(keyPaths(ja).sort());
  });

  test('空文字の文言が無い', () => {
    for (const locale of LOCALES) {
      const blank = leafValues(useTranslations(locale)).filter((value) => value.trim().length === 0);
      expect(blank).toEqual([]);
    }
  });

  test('ロケールごとに別の辞書を返す', () => {
    expect(useTranslations('ja').hero.cta).not.toBe(useTranslations('en').hero.cta);
  });
});

describe('resolveLocale', () => {
  test.each([
    ['en-US,en;q=0.9', 'en'],
    ['ja,en-US;q=0.9', 'ja'],
    ['en;q=0.4,ja;q=0.9', 'ja'],
    ['fr-FR,de;q=0.8', DEFAULT_LOCALE],
    ['', DEFAULT_LOCALE],
  ])('Accept-Language %s は %s', (header, expected) => {
    expect(resolveLocale(header as string)).toBe(expected as never);
  });

  test('ヘッダーが無いときは既定ロケール', () => {
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
  });

  test('q=0 の言語は選ばない', () => {
    expect(resolveLocale('en;q=0')).toBe('ja');
  });
});

describe('switchLocalePath', () => {
  test.each([
    ['/ja/', 'en', '/en/'],
    ['/ja/privacy/', 'en', '/en/privacy/'],
    ['/en/privacy/', 'ja', '/ja/privacy/'],
    ['/', 'en', '/en/'],
    ['/unknown/page/', 'ja', '/ja/'],
  ])('%s → %s', (pathname, target, expected) => {
    expect(switchLocalePath(pathname as string, target as 'ja' | 'en')).toBe(expected as string);
  });
});

describe('alternateLocale', () => {
  test('もう一方のロケールを返す', () => {
    expect(alternateLocale('ja')).toBe('en');
    expect(alternateLocale('en')).toBe('ja');
  });
});
