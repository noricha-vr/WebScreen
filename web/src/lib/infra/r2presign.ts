import { AwsClient } from 'aws4fetch';

/** R2 の S3 互換 API に署名するために必要な設定。 */
export interface R2PresignConfig {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** PUT 署名 URL の有効期間。保持期間バッチの最小掃除猶予とも共有する。 */
export const PRESIGN_TTL_MS = 5 * 60 * 1000;
/** 署名失効後の回収を始めるまでに許容する時計差。 */
export const PRESIGN_EXPIRY_GRACE_MS = PRESIGN_TTL_MS + 60 * 1000;
const PRESIGN_TTL_SECONDS = PRESIGN_TTL_MS / 1000;

/** R2 への video/mp4 専用、5分間有効な単発 PUT 署名 URL を発行する。 */
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
    headers: { 'Content-Type': 'video/mp4' },
    aws: { signQuery: true, allHeaders: true },
  });

  return signedRequest.url;
}
