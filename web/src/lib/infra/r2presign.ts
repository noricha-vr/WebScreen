import { AwsClient } from 'aws4fetch';

/** R2 の S3 互換 API に署名するために必要な設定。 */
export interface R2PresignConfig {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const PRESIGN_TTL_SECONDS = 60 * 60;

/** R2 への単発 PUT 用に1時間有効な署名 URL を発行する。 */
export async function createR2PutPresignedUrl(
  config: R2PresignConfig,
  key: string
): Promise<string> {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = new URL(
    `https://${config.accountId}.r2.cloudflarestorage.com/${encodeURIComponent(config.bucketName)}/${encodedKey}`
  );
  url.searchParams.set('X-Amz-Expires', String(PRESIGN_TTL_SECONDS));

  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: 's3',
    region: 'auto',
  });
  const signedRequest = await client.sign(url, {
    method: 'PUT',
    aws: { signQuery: true },
  });

  return signedRequest.url;
}
