import { describe, expect, test } from 'bun:test';

import { ERROR_CODES } from '../../src/lib/contracts/api';
import {
  CLIENT_ERROR_MAX_PER_KEY,
  CLIENT_ERROR_MIN_INTERVAL_MS,
  INITIAL_CLIENT_ERROR_THROTTLE,
  admitClientError,
  clientErrorCodeOf,
  clientErrorHttpStatus,
  clientErrorPayload,
  conversionClientStage,
  createClientErrorReporter,
} from '../../src/lib/ui/client-error-report';
import { JsonRequestError } from '../../src/lib/ui/request-json';

/** 送信本文を溜める報告関数。実送信（sendBeacon / fetch）は差し替える。 */
function reporterWithSpy(): { report: (r: Parameters<ReturnType<typeof createClientErrorReporter>>[0]) => void; sent: unknown[]; advance: (ms: number) => void } {
  const sent: unknown[] = [];
  let nowMs = 0;
  const report = createClientErrorReporter({
    send: (body) => sent.push(JSON.parse(body)),
    now: () => nowMs,
  });
  return { report, sent, advance: (ms) => { nowMs += ms; } };
}

describe('送信ペイロード', () => {
  test('送るのは stage / errorCode / httpStatus だけ', () => {
    const spy = reporterWithSpy();

    spy.report({ stage: 'upload', errorCode: 'failed', httpStatus: 500 });

    expect(spy.sent).toEqual([{ stage: 'upload', errorCode: 'failed', httpStatus: 500 }]);
  });

  test('httpStatus が無いときはキーごと送らない', () => {
    expect(Object.keys(clientErrorPayload({ stage: 'convert', errorCode: 'failed' }))).toEqual([
      'stage',
      'errorCode',
    ]);
  });

  test('呼び出し側が余分なフィールドを渡しても混入しない', () => {
    const contaminated = {
      stage: 'convert',
      errorCode: 'failed',
      url: 'https://example.com/private',
      stack: 'at secret.pdf',
    } as unknown as Parameters<typeof clientErrorPayload>[0];

    expect(clientErrorPayload(contaminated)).toEqual({ stage: 'convert', errorCode: 'failed' });
  });
});

describe('clientErrorCodeOf', () => {
  test('allowlist に載るサーバーコードはそのまま使う', () => {
    const error = new JsonRequestError(403, ERROR_CODES.forbidden);
    expect(clientErrorCodeOf(error)).toBe(ERROR_CODES.forbidden);
  });

  test('allowlist 外のサーバーコードは failed に丸める', () => {
    const error = new JsonRequestError(500, '<script>alert(1)</script>');
    expect(clientErrorCodeOf(error)).toBe('failed');
  });

  test('HTTP 由来でない失敗は failed になり、ステータスは付かない', () => {
    expect(clientErrorCodeOf(new Error('boom'))).toBe('failed');
    expect(clientErrorHttpStatus(new Error('boom'))).toBeUndefined();
    expect(clientErrorHttpStatus(new JsonRequestError(404, null))).toBe(404);
  });
});

describe('conversionClientStage', () => {
  test('進捗段階を報告する段へ写す', () => {
    expect(conversionClientStage('capturing')).toBe('capture');
    expect(conversionClientStage('preparing')).toBe('convert');
    expect(conversionClientStage('encoding')).toBe('convert');
    expect(conversionClientStage('uploading')).toBe('upload');
    expect(conversionClientStage(null)).toBe('convert');
  });
});

describe('送信の上限', () => {
  test('同じ段 + コードは上限までしか送らない', () => {
    let state = INITIAL_CLIENT_ERROR_THROTTLE;
    const report = { stage: 'convert', errorCode: 'failed' } as const;
    let admitted = 0;

    for (let i = 0; i < CLIENT_ERROR_MAX_PER_KEY + 5; i += 1) {
      const decision = admitClientError(state, report, i * CLIENT_ERROR_MIN_INTERVAL_MS);
      state = decision.state;
      if (decision.admitted) admitted += 1;
    }

    expect(admitted).toBe(CLIENT_ERROR_MAX_PER_KEY);
  });

  test('上限に達した組を弾いても、別の組は送れる', () => {
    let state = INITIAL_CLIENT_ERROR_THROTTLE;
    for (let i = 0; i < CLIENT_ERROR_MAX_PER_KEY; i += 1) {
      state = admitClientError(
        state,
        { stage: 'convert', errorCode: 'failed' },
        i * CLIENT_ERROR_MIN_INTERVAL_MS
      ).state;
    }

    const blocked = admitClientError(
      state,
      { stage: 'convert', errorCode: 'failed' },
      10 * CLIENT_ERROR_MIN_INTERVAL_MS
    );
    const other = admitClientError(
      blocked.state,
      { stage: 'upload', errorCode: 'failed' },
      11 * CLIENT_ERROR_MIN_INTERVAL_MS
    );

    expect(blocked.admitted).toBe(false);
    expect(other.admitted).toBe(true);
  });

  test('間隔の下限より詰まった報告は送らない（失敗ループでも溢れない）', () => {
    const first = admitClientError(
      INITIAL_CLIENT_ERROR_THROTTLE,
      { stage: 'capture', errorCode: 'failed' },
      1_000
    );
    const tooSoon = admitClientError(
      first.state,
      { stage: 'convert', errorCode: 'failed' },
      1_000 + CLIENT_ERROR_MIN_INTERVAL_MS - 1
    );
    const later = admitClientError(
      tooSoon.state,
      { stage: 'convert', errorCode: 'failed' },
      1_000 + CLIENT_ERROR_MIN_INTERVAL_MS
    );

    expect([first.admitted, tooSoon.admitted, later.admitted]).toEqual([true, false, true]);
  });

  test('弾いた報告は回数に数えない（上限に達したまま復帰できなくならない）', () => {
    const first = admitClientError(
      INITIAL_CLIENT_ERROR_THROTTLE,
      { stage: 'convert', errorCode: 'failed' },
      0
    );
    const blocked = admitClientError(first.state, { stage: 'convert', errorCode: 'failed' }, 1);

    expect(blocked.state).toBe(first.state);
  });

  test('報告関数も上限に従う', () => {
    const spy = reporterWithSpy();
    for (let i = 0; i < CLIENT_ERROR_MAX_PER_KEY + 3; i += 1) {
      spy.report({ stage: 'history', errorCode: 'failed' });
      spy.advance(CLIENT_ERROR_MIN_INTERVAL_MS);
    }

    expect(spy.sent).toHaveLength(CLIENT_ERROR_MAX_PER_KEY);
  });

  test('送信が失敗しても呼び出し側へ例外を投げない', () => {
    const report = createClientErrorReporter({
      send: () => {
        throw new Error('beacon unavailable');
      },
      now: () => 0,
    });

    expect(() => report({ stage: 'delete', errorCode: 'failed' })).not.toThrow();
  });
});
