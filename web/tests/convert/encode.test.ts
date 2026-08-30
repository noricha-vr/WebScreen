import { describe, expect, test } from 'bun:test';

import {
  buildFrameEncodeArgs,
  encodedFrameCount,
  encodePhaseRatio,
  frameFileName,
} from '../../src/lib/convert/encode';
import { fetchImagesInOrder } from '../../src/lib/convert/imageUrls';
import { assertPdfPageCount, MAX_PDF_PAGES } from '../../src/lib/convert/pdf';

describe('VRChat 向け FFmpeg 引数', () => {
  test('フレーム列の出力に互換性契約の全引数を含める', () => {
    const args = buildFrameEncodeArgs();

    expect(args).toEqual(expect.arrayContaining([
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline',
      '-bf', '0', '-g', '1', '-movflags', '+faststart',
    ]));
  });

  test('フレーム名は入力順を崩さない連番になる', () => {
    expect([frameFileName(0), frameFileName(1), frameFileName(10)]).toEqual([
      'frame-000000.png', 'frame-000001.png', 'frame-000010.png',
    ]);
  });
});

describe('エンコードの進捗', () => {
  test('FFmpeg の進み具合をフレーム枚数へ換算する', () => {
    expect([0, 0.5, 1].map((progress) => encodedFrameCount(progress, 100))).toEqual([0, 50, 100]);
  });

  test('範囲外の進み具合でも枚数は 0〜総数に収まる', () => {
    // FFmpeg は 1 を超える進み具合や NaN を返すことがあり、そのまま表示すると枚数が総数を超える。
    expect([1.2, -0.1, Number.NaN].map((progress) => encodedFrameCount(progress, 100))).toEqual([100, 0, 0]);
  });

  test('内部工程は段階内の区間へ写る（読み込み→書き出し→実行）', () => {
    // 段階の帯域 70〜95% に写すと 70→73→80→95% になる配分。
    expect(encodePhaseRatio('loading', 0, 1)).toBe(0);
    expect(encodePhaseRatio('loading', 1, 1)).toBeCloseTo(0.12);
    expect(encodePhaseRatio('writing', 0, 200)).toBeCloseTo(0.12);
    expect(encodePhaseRatio('writing', 200, 200)).toBeCloseTo(0.4);
    expect(encodePhaseRatio('running', 0, 200)).toBeCloseTo(0.4);
    expect(encodePhaseRatio('running', 200, 200)).toBe(1);
  });

  test('工程をまたいでも進み具合は単調増加する', () => {
    const ratios = [
      encodePhaseRatio('loading', 0, 1),
      encodePhaseRatio('loading', 0.9, 1),
      encodePhaseRatio('writing', 1, 200),
      encodePhaseRatio('writing', 200, 200),
      encodePhaseRatio('running', 1, 200),
      encodePhaseRatio('running', 200, 200),
    ];

    expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
  });

  test('総数が 0 や NaN でも工程の区間から出ない', () => {
    // 枚数が確定していない読み込み中でも、区間の先頭より前へは戻さない。
    expect(encodePhaseRatio('writing', 1, 0)).toBeCloseTo(0.12);
    expect(encodePhaseRatio('running', Number.NaN, 200)).toBeCloseTo(0.4);
    expect(encodePhaseRatio('running', 400, 200)).toBe(1);
  });
});

test('キャプチャ画像 URL は非同期応答順でなく配列順に取得する', async () => {
  const received: string[] = [];
  const blobs = await fetchImagesInOrder(['first', 'second', 'third'], async (url) => {
    received.push(url);
    return new Response(new Blob([url]));
  });

  expect(received).toEqual(['first', 'second', 'third']);
  expect(await Promise.all(blobs.map((blob) => blob.text()))).toEqual(['first', 'second', 'third']);
});

test('PDF は 200 ページを超えると変換前に拒否する', () => {
  expect(() => assertPdfPageCount(MAX_PDF_PAGES)).not.toThrow();
  expect(() => assertPdfPageCount(MAX_PDF_PAGES + 1)).toThrow('PDF has more than');
});
