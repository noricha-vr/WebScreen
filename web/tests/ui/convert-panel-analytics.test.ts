import { describe, expect, test } from 'bun:test';

import { uploadMp4 } from '../../src/lib/ui/convert-panel';

const PRESIGN = {
  shortId: 'Ab12Cd34Ef56',
  uploadUrl: 'https://upload.test/r2-upload',
  publicUrl: 'https://cdn.test/movies/Ab12Cd34Ef56.mp4',
};
const COMMIT = { ...PRESIGN, sizeBytes: 3, expiresAt: null };

async function runUpload(onComplete: () => void): Promise<void> {
  await uploadMp4(new Blob(['mp4']), 'slide.mp4', 'image', () => {}, 1, undefined, onComplete);
}

describe('uploadMp4 analytics', () => {
  test('R2 PUTとcommit成功後にだけcompleteを1回呼ぶ', async () => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const completed: string[] = [];
    Object.assign(globalThis, { fetch: async (url: string) => {
      requests.push(url);
      if (url === '/api/uploads/presign/') return Response.json(PRESIGN);
      if (url === '/api/uploads/commit/') return Response.json(COMMIT);
      return new Response(null, { status: 200 });
    } });

    try {
      await runUpload(() => completed.push('complete'));
      expect(requests).toEqual([
        '/api/uploads/presign/',
        'https://upload.test/r2-upload',
        '/api/uploads/commit/',
      ]);
      expect(completed).toEqual(['complete']);
    } finally {
      Object.assign(globalThis, { fetch: originalFetch });
    }
  });

  test('completeを送ってから画面遷移させる', async () => {
    // 遷移が先だと、離脱の速い利用者で送信前にページが差し替わる。
    const originalFetch = globalThis.fetch;
    const order: string[] = [];
    Object.assign(globalThis, { fetch: async (url: string) => {
      if (url === '/api/uploads/presign/') return Response.json(PRESIGN);
      if (url === '/api/uploads/commit/') return Response.json(COMMIT);
      return new Response(null, { status: 200 });
    } });

    try {
      await uploadMp4(
        new Blob(['mp4']),
        'slide.mp4',
        'image',
        (action) => order.push(action.type),
        1,
        undefined,
        () => order.push('complete')
      );

      expect(order.indexOf('complete')).toBeGreaterThan(-1);
      expect(order.indexOf('complete')).toBeLessThan(order.indexOf('uploaded'));
    } finally {
      Object.assign(globalThis, { fetch: originalFetch });
    }
  });

  test('計測observerが失敗してもcommit済み変換は成功のまま返す', async () => {
    const originalFetch = globalThis.fetch;
    Object.assign(globalThis, { fetch: async (url: string) => {
      if (url === '/api/uploads/presign/') return Response.json(PRESIGN);
      if (url === '/api/uploads/commit/') return Response.json(COMMIT);
      return new Response(null, { status: 200 });
    } });

    try {
      await expect(runUpload(() => { throw new Error('analytics blocked'); })).resolves.toBeUndefined();
    } finally {
      Object.assign(globalThis, { fetch: originalFetch });
    }
  });

  test.each([
    ['R2 PUT失敗', 'put'],
    ['commit HTTP失敗', 'commit-http'],
    ['commit不正本文', 'commit-invalid'],
  ] as const)('%sではcompleteを呼ばない', async (_label, failureAt) => {
    const originalFetch = globalThis.fetch;
    let completed = 0;
    Object.assign(globalThis, { fetch: async (url: string) => {
      if (url === '/api/uploads/presign/') return Response.json(PRESIGN);
      if (url === 'https://upload.test/r2-upload') {
        return new Response(null, { status: failureAt === 'put' ? 500 : 200 });
      }
      if (url === '/api/uploads/commit/') {
        return failureAt === 'commit-http'
          ? Response.json({ errorCode: 'UPLOAD_COMMIT_FAILED' }, { status: 500 })
          : Response.json({});
      }
      return new Response(null, { status: 200 });
    } });

    try {
      await runUpload(() => { completed += 1; }).catch(() => undefined);
      expect(completed).toBe(0);
    } finally {
      Object.assign(globalThis, { fetch: originalFetch });
    }
  });
});
