import { describe, expect, test } from 'bun:test';

import { ERROR_CODES } from '../../src/lib/contracts/api';
import {
  PRESIGN_RATE_LIMIT,
  PRESIGN_RATE_LIMIT_PERIOD_SECONDS,
  enforcePresignRateLimit,
  type PresignRateLimiter,
} from '../../src/lib/services/presign-rate-limit';

/** namespace 内のユーザー別カウンタを再現する Rate Limiting binding の代役。 */
class StatefulLimiter implements PresignRateLimiter {
  private readonly counts = new Map<string, number>();

  async limit({ key }: { key: string }): Promise<{ success: boolean }> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return { success: next <= PRESIGN_RATE_LIMIT };
  }
}

describe('presign のユーザー単位レート制限', () => {
  test('同じユーザーは最初の10回を許可し、11回目を429で拒否する', async () => {
    const limiter = new StatefulLimiter();

    for (let count = 0; count < PRESIGN_RATE_LIMIT; count += 1) {
      expect(await enforcePresignRateLimit(limiter, 42)).toBeNull();
    }

    const response = await enforcePresignRateLimit(limiter, 42);
    expect(response?.status).toBe(429);
    expect(response?.headers.get('Retry-After')).toBe(String(PRESIGN_RATE_LIMIT_PERIOD_SECONDS));
    expect(response?.headers.get('Cache-Control')).toBe('no-store');
    expect(await response?.json()).toEqual({
      errorCode: ERROR_CODES.tooManyPresignRequests,
      message: 'アップロードURLの発行回数が上限を超えました',
    });
  });

  test('カウンタのキーはユーザーごとに分離する', async () => {
    const limiter = new StatefulLimiter();
    for (let count = 0; count < PRESIGN_RATE_LIMIT; count += 1) {
      await enforcePresignRateLimit(limiter, 42);
    }

    expect((await enforcePresignRateLimit(limiter, 42))?.status).toBe(429);
    expect(await enforcePresignRateLimit(limiter, 84)).toBeNull();
  });

  test('binding の欠落や失敗は fail-open しない', async () => {
    await expect(enforcePresignRateLimit(undefined, 42)).rejects.toThrow(
      'PRESIGN_LIMITER binding is required'
    );
    await expect(
      enforcePresignRateLimit(
        { limit: async () => Promise.reject(new Error('binding unavailable')) },
        42
      )
    ).rejects.toThrow('binding unavailable');
  });
});
