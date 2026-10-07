import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

import { LANGUAGE_NEUTRAL_PATHS, hreflangAlternates } from '../../src/i18n';

const SITE = new URL('https://web-screen.net');
const PAGES_DIR = join(import.meta.dir, '../../src/pages');

describe('hreflangAlternates', () => {
  test.each([
    // 言語なしの振り分けページがあるものは、それを x-default にする。
    ['/ja/', 'https://web-screen.net/ja/', 'https://web-screen.net/en/', 'https://web-screen.net/'],
    ['/en/', 'https://web-screen.net/ja/', 'https://web-screen.net/en/', 'https://web-screen.net/'],
    ['/ja/web/', 'https://web-screen.net/ja/web/', 'https://web-screen.net/en/web/', 'https://web-screen.net/web/'],
    ['/en/pdf/', 'https://web-screen.net/ja/pdf/', 'https://web-screen.net/en/pdf/', 'https://web-screen.net/pdf/'],
    // 無いものは既定ロケール版（トップを指すと内容の対応しないページになる）。
    [
      '/en/video-player/',
      'https://web-screen.net/ja/video-player/',
      'https://web-screen.net/en/video-player/',
      'https://web-screen.net/ja/video-player/',
    ],
    ['/en/privacy/', 'https://web-screen.net/ja/privacy/', 'https://web-screen.net/en/privacy/', 'https://web-screen.net/ja/privacy/'],
  ])('%s は自分自身を含む全言語と x-default を絶対 URL で返す', (pathname, ja, en, xDefault) => {
    expect(hreflangAlternates(pathname, SITE)).toEqual([
      { hreflang: 'ja', href: ja },
      { hreflang: 'en', href: en },
      { hreflang: 'x-default', href: xDefault },
    ]);
  });

  test('言語なしの振り分けページの一覧が src/pages 直下の実体と一致する', () => {
    // screen-share は外部（ちょいキャス）へ送るだけで、自サイトに言語版を持たない。
    const actual = readdirSync(PAGES_DIR)
      .filter((name) => name.endsWith('.astro') && name !== 'screen-share.astro')
      .map((name) => (name === 'index.astro' ? '/' : `/${name.slice(0, -'.astro'.length)}/`));

    expect([...actual].sort()).toEqual([...LANGUAGE_NEUTRAL_PATHS].sort());
  });
});
