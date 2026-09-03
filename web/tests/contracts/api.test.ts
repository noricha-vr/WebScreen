import { describe, expect, test } from 'bun:test';

import {
  ERROR_CODES,
  MAX_CAPTURE_DIMENSION,
  MAX_CAPTURE_IMAGES,
  MAX_CAPTURE_REQUESTS,
  MAX_UPLOAD_BYTES,
  MIN_CAPTURE_DIMENSION,
  parseEstimatedImages,
  validateCreateStreamRequest,
  validateCaptureRequest,
  validateCommitRequest,
  validatePresignRequest,
  validateRenameMovieRequest,
} from '../../src/lib/contracts/api';

const VALID_SHORT_ID = 'aB3dE5fG7hJ9';

describe('ページ長の上限', () => {
  // web-capture の app/models.py に同じ値のリテラルがある（相互に import できないため、
  // 片側だけずれたらどちらかのテストで落とす）。根拠は docs/encode-contract.md の実測表。
  test('上限は 150 枚', () => {
    expect(MAX_CAPTURE_IMAGES).toBe(150);
  });

  test('上限いっぱいのページでも 50 MiB に収まる見込みである', () => {
    // 実測の最悪ケース（文字主体のページ）の 1 枚あたりバイト数。
    const worstCaseBytesPerImage = 262_507;

    expect(MAX_CAPTURE_IMAGES * worstCaseBytesPerImage).toBeLessThan(MAX_UPLOAD_BYTES);
  });

  test('分割取得の回数で上限枚数まで取り切れる', () => {
    // web-capture が 1 リクエストで撮る上限（app/config.py の max_capture_images）。
    const imagesPerRequest = 100;

    expect(MAX_CAPTURE_REQUESTS * imagesPerRequest).toBeGreaterThanOrEqual(MAX_CAPTURE_IMAGES);
  });
});

describe('parseEstimatedImages', () => {
  test('正の整数だけを受け取る', () => {
    expect(parseEstimatedImages({ estimatedImages: 402 })).toBe(402);
  });

  test('整数でない値・範囲外・欠落は null にする', () => {
    expect(parseEstimatedImages({ estimatedImages: '402' })).toBeNull();
    expect(parseEstimatedImages({ estimatedImages: 12.5 })).toBeNull();
    expect(parseEstimatedImages({ estimatedImages: 0 })).toBeNull();
    expect(parseEstimatedImages({ estimatedImages: 1_000_000 })).toBeNull();
    expect(parseEstimatedImages({ errorCode: 'PAGE_TOO_LONG' })).toBeNull();
    expect(parseEstimatedImages(null)).toBeNull();
  });
});

describe('validatePresignRequest', () => {
  test('正常なリクエストを受理する', () => {
    const result = validatePresignRequest({
      filename: 'slides.mp4',
      sizeBytes: 1024,
      kind: 'pdf',
    });

    expect(result).toEqual({
      ok: true,
      value: { filename: 'slides.mp4', sizeBytes: 1024, kind: 'pdf' },
    });
  });

  test('上限ちょうどのサイズは受理する', () => {
    const result = validatePresignRequest({
      filename: 'a.mp4',
      sizeBytes: MAX_UPLOAD_BYTES,
      kind: 'pdf',
    });

    expect(result.ok).toBe(true);
  });

  test('上限を超えるサイズは PAYLOAD_TOO_LARGE で拒否する', () => {
    const result = validatePresignRequest({
      filename: 'a.mp4',
      sizeBytes: MAX_UPLOAD_BYTES + 1,
      kind: 'pdf',
    });

    expect(result).toMatchObject({
      ok: false,
      error: { errorCode: ERROR_CODES.payloadTooLarge },
    });
  });

  test.each([
    ['ボディが配列', []],
    ['ボディが null', null],
    ['filename がパス区切りを含む', { filename: '../x.mp4', sizeBytes: 1, kind: 'pdf' }],
    ['filename が空', { filename: '', sizeBytes: 1, kind: 'pdf' }],
    ['filename が RTL override を含む', { filename: 'report\u202egpj.exe', sizeBytes: 1, kind: 'pdf' }],
    ['filename が C1 制御文字を含む', { filename: 'report\u0085.mp4', sizeBytes: 1, kind: 'pdf' }],
    ['filename が行区切りを含む', { filename: 'report\u2028.mp4', sizeBytes: 1, kind: 'pdf' }],
    ['sizeBytes が 0', { filename: 'a.mp4', sizeBytes: 0, kind: 'pdf' }],
    ['sizeBytes が小数', { filename: 'a.mp4', sizeBytes: 1.5, kind: 'pdf' }],
    ['kind が未知の値', { filename: 'a.mp4', sizeBytes: 1, kind: 'audio' }],
    ['kind が video', { filename: 'a.mp4', sizeBytes: 1, kind: 'video' }],
    ['kind が欠落', { filename: 'a.mp4', sizeBytes: 1 }],
  ])('%s は INVALID_REQUEST で拒否する', (_label, input) => {
    const result = validatePresignRequest(input);

    expect(result).toMatchObject({
      ok: false,
      error: { errorCode: ERROR_CODES.invalidRequest },
    });
  });
});

test('非Webページ URL の公開エラーコードを固定する', () => {
  expect(ERROR_CODES).toMatchObject({
    pdfUrlNotSupported: 'PDF_URL_NOT_SUPPORTED',
    imageUrlNotSupported: 'IMAGE_URL_NOT_SUPPORTED',
    videoUrlNotSupported: 'VIDEO_URL_NOT_SUPPORTED',
    nonWebPageUrl: 'NON_WEB_PAGE_URL',
  });
});

describe('validateCommitRequest', () => {
  test('12 文字 base62 の shortId を受理する', () => {
    expect(validateCommitRequest({ shortId: VALID_SHORT_ID })).toEqual({
      ok: true,
      value: { shortId: VALID_SHORT_ID },
    });
  });

  test.each([
    ['短い shortId', { shortId: 'abc' }],
    ['記号を含む shortId', { shortId: 'aB3dE5fG7h-9' }],
    ['shortId が数値', { shortId: 123 }],
    ['shortId が欠落', {}],
  ])('%s は拒否する', (_label, input) => {
    expect(validateCommitRequest(input).ok).toBe(false);
  });
});

describe('validateCreateStreamRequest', () => {
  test('id を省略した従来の作成と、12文字 ID の再利用を受理する', () => {
    expect(validateCreateStreamRequest({})).toEqual({ ok: true, value: {} });
    expect(validateCreateStreamRequest({ id: VALID_SHORT_ID })).toEqual({
      ok: true,
      value: { id: VALID_SHORT_ID },
    });
  });

  test.each([
    ['短い ID', { id: 'abc' }],
    ['記号を含む ID', { id: 'aB3dE5fG7h-9' }],
    ['数値の ID', { id: 123 }],
    ['余分な項目', { id: VALID_SHORT_ID, extra: true }],
    ['配列', []],
  ])('%s は INVALID_REQUEST で拒否する', (_label, input) => {
    expect(validateCreateStreamRequest(input)).toMatchObject({
      ok: false,
      error: { errorCode: ERROR_CODES.invalidRequest },
    });
  });
});

describe('validateCaptureRequest', () => {
  test('width / height を省略できる', () => {
    expect(validateCaptureRequest({ url: 'https://example.com/' })).toEqual({
      ok: true,
      value: { url: 'https://example.com/' },
    });
  });

  test('startIndex を上流へ渡す', () => {
    // ここで落とすと常に先頭からの撮影になり、同じ画像を繰り返し繋いでしまう
    expect(validateCaptureRequest({ url: 'https://example.com/', startIndex: 100 })).toEqual({
      ok: true,
      value: { url: 'https://example.com/', startIndex: 100 },
    });
  });

  test('負数や小数の startIndex を拒否する', () => {
    for (const startIndex of [-1, 1.5, Number.NaN, '10']) {
      const result = validateCaptureRequest({ url: 'https://example.com/', startIndex });
      expect(result.ok).toBe(false);
    }
  });

  test('範囲内の width / height を受理する', () => {
    const result = validateCaptureRequest({
      url: 'https://example.com/',
      width: MIN_CAPTURE_DIMENSION,
      height: MAX_CAPTURE_DIMENSION,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        url: 'https://example.com/',
        width: MIN_CAPTURE_DIMENSION,
        height: MAX_CAPTURE_DIMENSION,
      },
    });
  });

  test.each([
    ['http/https 以外のスキーム', { url: 'file:///etc/passwd' }],
    ['URL でない文字列', { url: 'example.com' }],
    ['url が欠落', {}],
    ['width が下限未満', { url: 'https://example.com/', width: MIN_CAPTURE_DIMENSION - 1 }],
    ['height が上限超過', { url: 'https://example.com/', height: MAX_CAPTURE_DIMENSION + 1 }],
    ['width が小数', { url: 'https://example.com/', width: 640.5 }],
  ])('%s は拒否する', (_label, input) => {
    expect(validateCaptureRequest(input).ok).toBe(false);
  });
});

describe('validateRenameMovieRequest', () => {
  test('前後の空白を落として受理する', () => {
    expect(validateRenameMovieRequest({ filename: ' renamed.mp4 ' })).toEqual({
      ok: true,
      value: { filename: 'renamed.mp4' },
    });
  });

  test.each([
    ['filename が空文字', { filename: '' }],
    ['filename が空白のみ', { filename: '   ' }],
    ['filename が 256 文字', { filename: 'a'.repeat(256) }],
    ['filename がパス区切りを含む', { filename: 'folder/file.mp4' }],
    // isSafeFilename を通していることの確認。全パターンは validatePresignRequest 側で網羅する。
    ['filename が親ディレクトリ参照', { filename: '..' }],
    ['filename が RTL override を含む', { filename: 'report\u202egpj.exe' }],
    ['filename が欠落', {}],
    ['filename が数値', { filename: 42 }],
    ['ボディが配列', []],
    ['ボディが null', null],
  ])('%s は INVALID_REQUEST で拒否する', (_label, input) => {
    expect(validateRenameMovieRequest(input)).toMatchObject({
      ok: false,
      error: { errorCode: ERROR_CODES.invalidRequest },
    });
  });
});
