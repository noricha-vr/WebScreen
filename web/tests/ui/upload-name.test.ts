import { describe, expect, test } from 'bun:test';

import { validatePresignRequest } from '../../src/lib/contracts/api';
import { movieNameForFiles, movieNameForUrl } from '../../src/lib/ui/upload-name';

/**
 * 生成した名前を実際の presign バリデータに掛ける。
 * 判定ロジックをテスト側に写すと契約がドリフトするため、正本をそのまま呼ぶ。
 */
function presignAccepts(filename: string): boolean {
  return validatePresignRequest({ filename, sizeBytes: 1024, kind: 'image' }).ok;
}

const JA_SUFFIX = '他{count}枚';
const EN_SUFFIX = '+{count}';

/** 制御文字はソースに直接書くとファイルごと壊れるので、コードポイントから組み立てる。 */
const CONTROL_CHAR = String.fromCharCode(1);

describe('movieNameForFiles', () => {
  test('1 件なら拡張子だけ mp4 に替える', () => {
    expect(movieNameForFiles(['slides.pdf'], JA_SUFFIX)).toBe('slides.mp4');
  });

  test('拡張子が無いファイルはそのまま mp4 を足す', () => {
    expect(movieNameForFiles(['README'], JA_SUFFIX)).toBe('README.mp4');
  });

  test('複数件は先頭ファイル名に「先頭以外の枚数」を添える（日本語）', () => {
    const names = ['IMG_1234.jpg', 'IMG_1235.jpg', 'IMG_1236.jpg', 'IMG_1237.jpg'];
    expect(movieNameForFiles(names, JA_SUFFIX)).toBe('IMG_1234 他3枚.mp4');
  });

  test('複数件の接尾辞はテンプレートで切り替わる（英語）', () => {
    const names = ['IMG_1234.jpg', 'IMG_1235.jpg', 'IMG_1236.jpg', 'IMG_1237.jpg'];
    expect(movieNameForFiles(names, EN_SUFFIX)).toBe('IMG_1234 +3.mp4');
  });

  test('2 件のときの枚数は 1', () => {
    expect(movieNameForFiles(['first.png', 'second.png'], JA_SUFFIX)).toBe('first 他1枚.mp4');
  });

  test('ファイルが無ければ既定名にする', () => {
    expect(movieNameForFiles([], JA_SUFFIX)).toBe('capture.mp4');
  });

  test('パス区切り・制御文字を含むファイル名は - に置き換える', () => {
    const name = movieNameForFiles([`a/b\\c${CONTROL_CHAR}d.png`], JA_SUFFIX);

    expect(name).toBe('a-b-c-d.mp4');
    expect(presignAccepts(name)).toBe(true);
  });

  test('上限ぎりぎりの長いファイル名に接尾辞を足しても presign を通る', () => {
    // 250 文字 base + 「 他3枚」+ .mp4 は素直に繋ぐと 255 文字を超える
    const long = `${'a'.repeat(250)}.jpg`;
    const name = movieNameForFiles([long, 'b.jpg', 'c.jpg', 'd.jpg'], JA_SUFFIX);

    expect(name.endsWith(' 他3枚.mp4')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(255);
    expect(presignAccepts(name)).toBe(true);
  });

  test('長いファイル名は 1 件のときも presign を通る長さに収める', () => {
    const name = movieNameForFiles([`${'あ'.repeat(300)}.png`], JA_SUFFIX);

    expect(name.length).toBeLessThanOrEqual(255);
    expect(presignAccepts(name)).toBe(true);
  });

  test('上限内のファイル名は切り詰めずそのまま使う', () => {
    const base = 'a'.repeat(240);

    expect(movieNameForFiles([`${base}.jpg`], JA_SUFFIX)).toBe(`${base}.mp4`);
  });

  test('接尾辞が異常に長い辞書値でも上限を超えない', () => {
    const name = movieNameForFiles(['photo.jpg', 'b.jpg'], 'x'.repeat(400));

    expect(name.length).toBeLessThanOrEqual(255);
    expect(presignAccepts(name)).toBe(true);
  });

  test('絵文字入りの長いファイル名でも壊れた文字を残さない', () => {
    const name = movieNameForFiles([`${'🎬'.repeat(200)}.png`, 'b.png'], JA_SUFFIX);

    // サロゲートペアの片割れ（孤立サロゲート）が残っていないこと
    const hasLoneSurrogate = [...name].some((char) => {
      const code = char.charCodeAt(0);
      return char.length === 1 && code >= 0xd800 && code <= 0xdfff;
    });

    expect(name.length).toBeLessThanOrEqual(255);
    expect(hasLoneSurrogate).toBe(false);
    expect(presignAccepts(name)).toBe(true);
  });
});

describe('movieNameForUrl', () => {
  test.each([
    ['ルート直下はホスト名だけ', 'https://example.com/', 'example.com.mp4'],
    ['パスが無い URL もホスト名だけ', 'https://example.com', 'example.com.mp4'],
    ['深いパスは末尾セグメントを使う', 'https://zenn.dev/noricha/articles/abc123', 'zenn.dev-abc123.mp4'],
    ['末尾スラッシュは無視する', 'https://zenn.dev/noricha/articles/abc123/', 'zenn.dev-abc123.mp4'],
    ['index.html はスキップして 1 つ手前を使う', 'https://example.com/docs/guide/index.html', 'example.com-guide.mp4'],
    ['index.* だけのパスはホスト名だけ', 'https://example.com/index.php', 'example.com.mp4'],
    ['クエリとハッシュは無視する', 'https://example.com/blog/post-1?utm=x&a=b#section', 'example.com-post-1.mp4'],
    ['ポート番号付きでもホスト名だけを使う', 'http://localhost:4322/ja/privacy/', 'localhost-privacy.mp4'],
  ])('%s', (_label, url, expected) => {
    expect(movieNameForUrl(url as string)).toBe(expected as string);
  });

  test('日本語のパスはデコードして読める名前にする', () => {
    expect(movieNameForUrl('https://example.com/記事/動画変換')).toBe('example.com-動画変換.mp4');
  });

  test('パス区切りにデコードされる文字は - に置き換える', () => {
    expect(movieNameForUrl('https://example.com/a%2Fb')).toBe('example.com-a-b.mp4');
  });

  test('長すぎる URL は拡張子込み 80 文字に収める', () => {
    const name = movieNameForUrl(`https://example.com/${'a'.repeat(200)}`);

    expect(name.length).toBe(80);
    expect(name.endsWith('.mp4')).toBe(true);
    expect(name.startsWith('example.com-aaa')).toBe(true);
  });

  test('URL として読めない入力は既定名にフォールバックする', () => {
    expect(movieNameForUrl('not a url')).toBe('capture.mp4');
    expect(movieNameForUrl('')).toBe('capture.mp4');
    expect(movieNameForUrl('file:///etc/passwd')).toBe('capture.mp4');
  });

  test('生成した名前はどれも presign に渡せる', () => {
    const urls = [
      'https://example.com/',
      'https://zenn.dev/noricha/articles/abc123',
      'https://example.com/a%2Fb',
      'https://example.com/記事/動画変換',
      `https://example.com/${'a'.repeat(200)}`,
      'not a url',
    ];

    for (const url of urls) {
      expect(presignAccepts(movieNameForUrl(url))).toBe(true);
    }
  });
});
