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

/**
 * Astro がページとして扱う拡張子。`.astro` だけを見ていると、Markdown ページを足した時に
 * sitemap の更新漏れを見逃す。増やす時は Astro のドキュメントと突き合わせること。
 */
const PAGE_EXTENSIONS = ['.astro', '.md', '.mdx', '.html'];

/** src/pages/ を辿って、検索エンジンに出したい静的ページの URL を組み立てる。 */
function collectPublicPaths(dir: string, prefix = ''): string[] {
  const paths: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED.has(entry.name)) continue;
    if (entry.isDirectory()) {
      paths.push(...collectPublicPaths(join(dir, entry.name), `${prefix}/${entry.name}`));
      continue;
    }

    const extension = PAGE_EXTENSIONS.find((candidate) => entry.name.endsWith(candidate));
    if (extension === undefined) continue;

    const basename = entry.name.slice(0, -extension.length);

    // ルート直下の index だけは言語振り分けの 302 なので載せない（/ja/ /en/ が実体）。
    // 配下の ja/index・en/index は載せる対象なので、prefix で区別する。
    if (prefix === '' && basename === 'index') continue;

    // trailingSlash: 'always' なので、index はディレクトリ URL、それ以外は自身の名前。
    paths.push(`${SITE_ORIGIN}${prefix}${basename === 'index' ? '' : `/${basename}`}/`);
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
    // hreflang の alternate も同じ制約を受けるので一緒に見る。
    const xml = readFileSync(SITEMAP_PATH, 'utf-8');
    const alternates = [...xml.matchAll(/<xhtml:link[^>]+href="([^"]+)"/g)].map((m) => m[1]!);

    expect(alternates.length).toBeGreaterThan(0);
    for (const url of [...sitemapLocations(), ...alternates]) {
      expect(url.startsWith(`${SITE_ORIGIN}/`)).toBe(true);
    }
  });

  test('alternate は sitemap に載せた URL だけを指す', () => {
    // 除外したページ（プレビュー等）へ alternate で誘導してしまう事故を防ぐ。
    const xml = readFileSync(SITEMAP_PATH, 'utf-8');
    const alternates = new Set(
      [...xml.matchAll(/<xhtml:link[^>]+href="([^"]+)"/g)].map((m) => m[1]!)
    );

    expect([...alternates].sort()).toEqual(sitemapLocations().sort());
  });
});

describe('robots.txt', () => {
  const robots = readFileSync(join(import.meta.dir, '../../public/robots.txt'), 'utf-8');

  test('sitemap の場所を指している', () => {
    expect(robots).toContain(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`);
  });

  test('API をクロール対象から外している', () => {
    // 全 API が /api/ 配下にある前提。エンドポイントを別の階層へ移したらここが落ちる。
    expect(robots).toContain('Disallow: /api/');
  });
});
