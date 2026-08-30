import { describe, expect, jest, test } from 'bun:test';

import {
  buildFrameEncodeArgs,
  encodedFrameCount,
  encodePhaseRatio,
  frameFileName,
  runningProgress,
  startLoadPseudoProgress,
} from '../../src/lib/convert/encode';
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

  test('実行中はバーを生の進み具合、枚数を丸めた値で報告する', () => {
    // 丸めた枚数からバーを作ると、フレームが 1 枚のときは生進捗 49% まで区間の先頭
    // （表示 80%）で止まり、50% で終端（表示 95%）へ飛んで完了前に 95% を出してしまう。
    const ratios = [0, 0.25, 0.49, 0.5, 0.75, 1].map((progress) => runningProgress(progress, 1).ratio ?? 0);

    expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
    expect(new Set(ratios).size).toBe(ratios.length);
    expect(ratios[0]).toBeCloseTo(0.4);
    expect(ratios.at(-1)).toBe(1);
    // 枚数の表示は従来どおり丸めた値。
    expect(runningProgress(0.5, 200).current).toBe(100);
  });

  test('読み込みの擬似進捗は上限に達したら刻むのをやめる', () => {
    jest.useFakeTimers();
    const ratios: number[] = [];
    const stop = startLoadPseudoProgress(200, (progress) => ratios.push(progress.ratio ?? 0));

    jest.advanceTimersByTime(60_000);
    const cappedCount = ratios.length;
    jest.advanceTimersByTime(60_000);
    stop();
    jest.useRealTimers();

    // 読み込みが返らないまま（オフライン・CDN 停止）でも、上限へ達した後は通知しない。
    expect(cappedCount).toBeGreaterThan(0);
    expect(ratios.length).toBe(cappedCount);
    expect(ratios).toEqual([...ratios].sort((a, b) => a - b));
    // 読み込み完了の合図（区間の端）へは擬似進捗では届かせない。
    expect(ratios.at(-1)).toBeLessThan(encodePhaseRatio('loading', 1, 1));
  });

  test('総数が 0 や NaN でも工程の区間から出ない', () => {
    // 枚数が確定していない読み込み中でも、区間の先頭より前へは戻さない。
    expect(encodePhaseRatio('writing', 1, 0)).toBeCloseTo(0.12);
    expect(encodePhaseRatio('running', Number.NaN, 200)).toBeCloseTo(0.4);
    expect(encodePhaseRatio('running', 400, 200)).toBe(1);
  });
});

test('PDF は 200 ページを超えると変換前に拒否する', () => {
  expect(() => assertPdfPageCount(MAX_PDF_PAGES)).not.toThrow();
  expect(() => assertPdfPageCount(MAX_PDF_PAGES + 1)).toThrow('PDF has more than');
});
