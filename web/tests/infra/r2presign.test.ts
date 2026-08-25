import { expect, it } from 'bun:test';

import { createR2PutPresignedUrl } from '../../src/lib/infra/r2presign';

it('R2 PUT 用に video/mp4 固定・5分有効なクエリ署名 URL を発行する', async () => {
  const url = new URL(
    await createR2PutPresignedUrl(
      {
        accountId: 'account-id',
        bucketName: 'webscreen-beta',
        accessKeyId: 'access-key-id',
        secretAccessKey: 'secret-access-key',
      },
      'movies/AbCdEf123456.mp4'
    )
  );

  expect(url.origin).toBe('https://account-id.r2.cloudflarestorage.com');
  expect(url.pathname).toBe('/webscreen-beta/movies/AbCdEf123456.mp4');
  expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
  expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
  expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
  expect(url.searchParams.get('X-Amz-Signature')).not.toBeNull();
});
