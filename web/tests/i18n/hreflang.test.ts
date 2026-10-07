import { describe, expect, test } from 'bun:test';

import { hreflangAlternates } from '../../src/i18n';

const SITE = new URL('https://web-screen.net');

describe('hreflangAlternates', () => {
  test.each([
    ['/ja/', 'https://web-screen.net/ja/', 'https://web-screen.net/en/'],
    ['/en/', 'https://web-screen.net/ja/', 'https://web-screen.net/en/'],
    ['/ja/web/', 'https://web-screen.net/ja/web/', 'https://web-screen.net/en/web/'],
    ['/en/video-player/', 'https://web-screen.net/ja/video-player/', 'https://web-screen.net/en/video-player/'],
  ])('%s は自分自身を含む全言語と x-default を絶対 URL で返す', (pathname, ja, en) => {
    expect(hreflangAlternates(pathname, SITE)).toEqual([
      { hreflang: 'ja', href: ja },
      { hreflang: 'en', href: en },
      // 言語振り分けのトップ（Accept-Language で /ja/ か /en/ へ 302）。
      { hreflang: 'x-default', href: 'https://web-screen.net/' },
    ]);
  });
});
