import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * sitemap.xml と実際の公開ページの突合。
 *
 * sitemap は手書きの静的ファイルなので、ページを増やした時に更新を忘れる。
 * src/pages/ の実体から期待値を導き、ズレたらここで落とす。
 */

const PAGES_DIR = join(import.meta.dir, '../../src/pages');
const SITEMAP_PATH = join(import.meta.dir, '../../public/sitemap.xml');
const SITE_ORIGIN = 'https://web-screen.net';

/** sitemap に載せないページ。載せない理由はそれぞれ sitemap.xml のコメントに書いてある。 */
const EXCLUDED = new Set([
  // 動画のプレビュー。共有 URL を知っている人だけが開く前提（noindex）
  '[shortId]',
  // HTML ではない
  'api',
]);

/** src/pages/ を辿って、検索エンジンに出したい静的ページの URL を組み立てる。 */
function collectPublicPaths(dir: string, prefix = ''): string[] {
  const paths: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue;
    // ルート直下の index.astro だけは言語振り分けの 302 なので載せない（/ja/ /en/ が実体）。
    // 配下の ja/index.astro・en/index.astro は載せる対象なので、prefix で区別する。
    if (prefix === '' && entry.name === 'index.astro') continue;

    if (entry.isDirectory()) {
      paths.push(...collectPublicPaths(join(dir, entry.name), `${prefix}/${entry.name}`));
      continue;
    }
    if (!entry.name.endsWith('.astro')) continue;

    // trailingSlash: 'always' なので、index.astro はディレクトリ URL、それ以外は自身の名前。
    const slug = entry.name === 'index.astro' ? '' : `/${entry.name.replace(/\.astro$/, '')}`;
    paths.push(`${SITE_ORIGIN}${prefix}${slug}/`);
  }

  return paths;
}

function sitemapLocations(): string[] {
  const xml = readFileSync(SITEMAP_PATH, 'utf-8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
}

describe('sitemap.xml', () => {
  test('公開ページを過不足なく列挙している', () => {
    const expected = collectPublicPaths(PAGES_DIR).sort();
    const actual = sitemapLocations().sort();

    expect(actual).toEqual(expected);
  });

  test('URL はすべて本番オリジンの絶対 URL で書く', () => {
    // 相対パスや workers.dev のままだと Search Console が受け付けない。
    for (const loc of sitemapLocations()) {
      expect(loc.startsWith(`${SITE_ORIGIN}/`)).toBe(true);
    }
  });

  test('robots.txt が sitemap の場所を指している', () => {
    const robots = readFileSync(join(import.meta.dir, '../../public/robots.txt'), 'utf-8');

    expect(robots).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  });
});
