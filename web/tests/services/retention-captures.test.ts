import { describe, expect, it } from 'bun:test';

import { captureKey } from '../../src/lib/contracts/r2key';
import {
  CAPTURE_KEY_PREFIX,
  deleteStaleCaptures,
  MAX_CAPTURE_DELETIONS_PER_RUN,
  MAX_CAPTURE_LIST_PAGES_PER_RUN,
  type CaptureBucket,
  type CaptureListResult,
  type CaptureObject,
} from '../../src/lib/services/retention-captures';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

class FakeCaptureBucket implements CaptureBucket {
  readonly deleted: string[] = [];
  readonly listCalls: (string | undefined)[] = [];

  constructor(private readonly pages: CaptureListResult[] = [{ objects: [], truncated: false }]) {}

  async delete(keys: string | string[]): Promise<void> {
    this.deleted.push(...(Array.isArray(keys) ? keys : [keys]));
  }

  async list(options: { prefix: string; cursor?: string }): Promise<CaptureListResult> {
    this.listCalls.push(options.cursor);
    const index = options.cursor === undefined ? 0 : Number(options.cursor);
    return this.pages[index] ?? { objects: [], truncated: false };
  }
}

function captureObject(index: number, uploadedOffsetMs: number): CaptureObject {
  return {
    key: captureKey('11111111-2222-3333-4444-555555555555', index),
    uploaded: new Date(NOW.getTime() + uploadedOffsetMs),
  };
}

describe('deleteStaleCaptures', () => {
  // 掃除は拡張子を見ない。web-capture が png から jpg へ切り替わっても取り残しが出ないこと。
  it.each([['png'], ['jpg']] as const)('%s のキーも prefix で拾える', (extension) => {
    expect(
      captureKey('11111111-2222-3333-4444-555555555555', 0, extension).startsWith(
        CAPTURE_KEY_PREFIX
      )
    ).toBe(true);
  });

  it('24h ちょうどは残し、それより古いものだけ消す（境界）', async () => {
    const boundary = captureObject(0, -DAY_MS);
    const older = captureObject(1, -DAY_MS - 1);
    const bucket = new FakeCaptureBucket([{ objects: [boundary, older], truncated: false }]);

    const result = await deleteStaleCaptures(bucket, NOW);

    expect(result).toEqual({ deleted: 1, capped: false });
    expect(bucket.deleted).toEqual([older.key]);
  });

  it('cursor を辿って次ページも削除する', async () => {
    const first = captureObject(0, -2 * DAY_MS);
    const second = captureObject(1, -2 * DAY_MS);
    const bucket = new FakeCaptureBucket([
      { objects: [first], truncated: true, cursor: '1' },
      { objects: [second], truncated: false },
    ]);

    const result = await deleteStaleCaptures(bucket, NOW);

    expect(result).toEqual({ deleted: 2, capped: false });
    expect(bucket.listCalls).toEqual([undefined, '1']);
    expect(bucket.deleted).toEqual([first.key, second.key]);
  });

  it('1 回の実行で上限件数まで消し、残りは次回に回す', async () => {
    const pageSize = 600;
    const page = (cursor: string | undefined): CaptureListResult => ({
      objects: Array.from({ length: pageSize }, (_, index) => captureObject(index, -2 * DAY_MS)),
      truncated: true,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const bucket = new FakeCaptureBucket([page('1'), page('2'), page('3')]);

    const result = await deleteStaleCaptures(bucket, NOW);

    expect(result.deleted).toBe(MAX_CAPTURE_DELETIONS_PER_RUN);
    expect(result.capped).toBe(true);
    expect(bucket.deleted).toHaveLength(MAX_CAPTURE_DELETIONS_PER_RUN);
    expect(bucket.listCalls).toEqual([undefined, '1']);
  });

  it('削除対象が無くても list のページ数で打ち切る', async () => {
    // 消す対象は無いが truncated が続くケース（走査だけが伸びる）。
    const fresh = (cursor: string): CaptureListResult => ({
      objects: [captureObject(0, -1)],
      truncated: true,
      cursor,
    });
    const bucket = new FakeCaptureBucket(
      Array.from({ length: MAX_CAPTURE_LIST_PAGES_PER_RUN + 5 }, (_, index) =>
        fresh(String(index + 1))
      )
    );

    const result = await deleteStaleCaptures(bucket, NOW);

    expect(result).toEqual({ deleted: 0, capped: true });
    expect(bucket.listCalls).toHaveLength(MAX_CAPTURE_LIST_PAGES_PER_RUN);
  });
});
