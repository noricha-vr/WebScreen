import { afterEach, describe, expect, test } from 'bun:test';

import { logWorkerFailure } from '../../src/lib/observability/worker-log';

const originalError = console.error;
const originalWarn = console.warn;

afterEach(() => {
  console.error = originalError;
  console.warn = originalWarn;
});

describe('logWorkerFailure', () => {
  test('warn は console.warn へ出力する', () => {
    const warnings: string[] = [];
    const errors: string[] = [];
    console.warn = ((entry: string) => warnings.push(entry)) as typeof console.warn;
    console.error = ((entry: string) => errors.push(entry)) as typeof console.error;

    logWorkerFailure({
      level: 'warn',
      event: 'capture_request_json_invalid',
      errorCode: 'INVALID_REQUEST',
      status: 400,
    });

    expect(warnings).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });
});
