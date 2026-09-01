import { createMediaMtxClient, type MediaMtxClient } from '../infra/mediamtx';

/** cron entrypoint が infra へ直接依存せず MediaMTX adapter を組み立てる公開口。 */
export function createStreamMediaMtxClient(config: {
  apiUrl: string;
  apiToken: string;
}): MediaMtxClient {
  return createMediaMtxClient(config);
}
