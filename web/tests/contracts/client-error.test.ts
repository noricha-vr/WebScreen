import { describe, expect, test } from 'bun:test';

import { ERROR_CODES } from '../../src/lib/contracts/api';
import {
  CLIENT_ERROR_CODES,
  isClientErrorCode,
  validateClientErrorReport,
} from '../../src/lib/contracts/client-error';
import { UPLOAD_ERROR_CODES } from '../../src/lib/ui/upload-flow';

describe('validateClientErrorReport', () => {
  test('段と表示コードだけの報告を受理する', () => {
    const result = validateClientErrorReport({ stage: 'capture', errorCode: 'captureTimeout' });
    expect(result).toEqual({ ok: true, value: { stage: 'capture', errorCode: 'captureTimeout' } });
  });

  test('httpStatus 付きの報告を受理する', () => {
    const result = validateClientErrorReport({
      stage: 'pin',
      errorCode: ERROR_CODES.forbidden,
      httpStatus: 403,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.httpStatus).toBe(403);
  });

  test('未知のフィールドは拒否する（自由記述の抜け道を作らない）', () => {
    const result = validateClientErrorReport({
      stage: 'convert',
      errorCode: 'failed',
      message: 'file:///Users/me/secret.pdf を変換中に失敗',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.errorCode).toBe(ERROR_CODES.invalidRequest);
  });

  test('allowlist に無い errorCode は拒否する', () => {
    expect(validateClientErrorReport({ stage: 'convert', errorCode: 'MADE_UP' }).ok).toBe(false);
    expect(
      validateClientErrorReport({ stage: 'convert', errorCode: 'https://example.com/private' }).ok
    ).toBe(false);
  });

  test('未知の stage は拒否する', () => {
    expect(validateClientErrorReport({ stage: 'nowhere', errorCode: 'failed' }).ok).toBe(false);
  });

  test('httpStatus は 100〜599 の整数だけ受け付ける', () => {
    const base = { stage: 'upload', errorCode: 'failed' };
    expect(validateClientErrorReport({ ...base, httpStatus: 99 }).ok).toBe(false);
    expect(validateClientErrorReport({ ...base, httpStatus: 600 }).ok).toBe(false);
    expect(validateClientErrorReport({ ...base, httpStatus: 4.5 }).ok).toBe(false);
    expect(validateClientErrorReport({ ...base, httpStatus: '500' }).ok).toBe(false);
    expect(validateClientErrorReport({ ...base, httpStatus: 500 }).ok).toBe(true);
  });

  test('オブジェクト以外は拒否する', () => {
    expect(validateClientErrorReport(null).ok).toBe(false);
    expect(validateClientErrorReport('failed').ok).toBe(false);
    expect(validateClientErrorReport([{ stage: 'convert', errorCode: 'failed' }]).ok).toBe(false);
  });
});

describe('CLIENT_ERROR_CODES', () => {
  test('UI の表示コードをすべて含む（表示だけできて報告できないコードを作らない）', () => {
    const missing = UPLOAD_ERROR_CODES.filter((code) => !isClientErrorCode(code));
    expect(missing).toEqual([]);
  });

  test('API のエラーコードをすべて含む', () => {
    const missing = Object.values(ERROR_CODES).filter((code) => !isClientErrorCode(code));
    expect(missing).toEqual([]);
  });

  test('未知の文字列は含まない', () => {
    expect(CLIENT_ERROR_CODES).not.toContain('MADE_UP' as never);
    expect(isClientErrorCode('MADE_UP')).toBe(false);
  });
});
