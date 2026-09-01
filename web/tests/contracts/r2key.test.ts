import { describe, expect, test } from 'bun:test';

import {
  MAX_CAPTURE_INDEX,
  SHORT_ID_ALPHABET,
  SHORT_ID_LENGTH,
  captureKey,
  generateShortId,
  isShortId,
  movieKey,
  temporaryUploadKey,
} from '../../src/lib/contracts/r2key';

const SESSION_ID = '0f9c2b1a-4d3e-4a6b-8c7d-1e2f3a4b5c6d';

/** 指定バイト列を順に供給する RandomFill。乱数に依存させないための注入口。 */
function fillFrom(source: number[]): (bytes: Uint8Array<ArrayBuffer>) => void {
  let cursor = 0;
  return (bytes) => {
    for (let i = 0; i < bytes.length; i += 1) {
      const value = source[cursor % source.length];
      if (value === undefined) throw new Error('fillFrom: source が空です');
      bytes[i] = value;
      cursor += 1;
    }
  };
}

describe('generateShortId', () => {
  test('12 文字の base62 文字列を返す', () => {
    const id = generateShortId();

    expect(id).toHaveLength(SHORT_ID_LENGTH);
    expect(isShortId(id)).toBe(true);
  });

  test('モジュラーバイアスの原因になる 248 以上のバイトを棄却して再サンプルする', () => {
    // 248〜255 は 62 の倍数を超える端数。採用されると先頭 8 文字の出現確率が偏る。
    const rejected = [248, 249, 250, 251, 252, 253, 254, 255];
    const accepted = [0, 1, 2, 61, 62, 123, 200, 247];

    const id = generateShortId(fillFrom([...rejected, ...accepted]));

    expect(id).toHaveLength(SHORT_ID_LENGTH);
    // 棄却分が読み飛ばされ、accepted のみが accepted の順で写像される
    const expected = [...accepted, ...accepted]
      .slice(0, SHORT_ID_LENGTH)
      .map((byte) => SHORT_ID_ALPHABET[byte % SHORT_ID_ALPHABET.length])
      .join('');
    expect(id).toBe(expected);
  });

  test('全バイト値が base62 の範囲に写像される', () => {
    const allBytes = Array.from({ length: 256 }, (_, i) => i);

    const id = generateShortId(fillFrom(allBytes));

    expect([...id].every((char) => SHORT_ID_ALPHABET.includes(char))).toBe(true);
  });
});

describe('movieKey', () => {
  test('movies/{shortId}.mp4 を返す', () => {
    expect(movieKey('aB3dE5fG7hJ9')).toBe('movies/aB3dE5fG7hJ9.mp4');
  });

  test.each([
    ['短すぎる', 'abc'],
    ['記号を含む', 'aB3dE5fG7h/9'],
    ['長すぎる', 'aB3dE5fG7hJ9X'],
  ])('%s shortId は拒否する', (_label, value) => {
    expect(() => movieKey(value)).toThrow(/shortId/);
  });
});

describe('temporaryUploadKey', () => {
  test('tmp/{shortId} を返す', () => {
    expect(temporaryUploadKey('aB3dE5fG7hJ9')).toBe('tmp/aB3dE5fG7hJ9');
  });

  test.each([
    ['短すぎる', 'abc'],
    ['記号を含む', 'aB3dE5fG7h/9'],
    ['長すぎる', 'aB3dE5fG7hJ9X'],
  ])('%s shortId は拒否する', (_label, value) => {
    expect(() => temporaryUploadKey(value)).toThrow(/shortId/);
  });
});

describe('captureKey', () => {
  test('index を 0 埋め 4 桁にする', () => {
    expect(captureKey(SESSION_ID, 0)).toBe(`captures/${SESSION_ID}/0000.png`);
    expect(captureKey(SESSION_ID, 7)).toBe(`captures/${SESSION_ID}/0007.png`);
    expect(captureKey(SESSION_ID, MAX_CAPTURE_INDEX)).toBe(`captures/${SESSION_ID}/9999.png`);
  });

  test('web-capture が jpg を書いても同じ規則でキーを導出できる', () => {
    expect(captureKey(SESSION_ID, 7, 'jpg')).toBe(`captures/${SESSION_ID}/0007.jpg`);
  });

  test.each([['png'], ['jpg']] as const)(
    '%s でも辞書順が撮影順と一致する（R2 list の並びでコマ順が壊れない）',
    (extension) => {
      const shootingOrder = [0, 1, 2, 9, 10, 11, 100, 1000];

      const keys = shootingOrder.map((index) => captureKey(SESSION_ID, index, extension));

      expect([...keys].sort()).toEqual(keys);
    }
  );

  test.each([
    ['負の index', -1],
    ['上限超えの index', MAX_CAPTURE_INDEX + 1],
    ['整数でない index', 1.5],
  ])('%s は拒否する', (_label, index) => {
    expect(() => captureKey(SESSION_ID, index)).toThrow(/index/);
  });

  test('UUID でない sessionId は拒否する（キー空間の汚染とパス脱出を防ぐ）', () => {
    expect(() => captureKey('../../etc', 0)).toThrow(/sessionId/);
  });
});
