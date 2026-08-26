import { describe, expect, test } from 'bun:test';

import {
  ERROR_CODES,
  MAX_CAPTURE_DIMENSION,
  MAX_UPLOAD_BYTES,
  MIN_CAPTURE_DIMENSION,
  validateCaptureRequest,
  validateCommitRequest,
  validatePresignRequest,
} from '../../src/lib/contracts/api';

const VALID_SHORT_ID = 'aB3dE5fG7hJ9';

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
      kind: 'video',
    });

    expect(result.ok).toBe(true);
  });

  test('上限を超えるサイズは PAYLOAD_TOO_LARGE で拒否する', () => {
    const result = validatePresignRequest({
      filename: 'a.mp4',
      sizeBytes: MAX_UPLOAD_BYTES + 1,
      kind: 'video',
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
    ['kind が欠落', { filename: 'a.mp4', sizeBytes: 1 }],
  ])('%s は INVALID_REQUEST で拒否する', (_label, input) => {
    const result = validatePresignRequest(input);

    expect(result).toMatchObject({
      ok: false,
      error: { errorCode: ERROR_CODES.invalidRequest },
    });
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

describe('validateCaptureRequest', () => {
  test('width / height を省略できる', () => {
    expect(validateCaptureRequest({ url: 'https://example.com/' })).toEqual({
      ok: true,
      value: { url: 'https://example.com/' },
    });
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
