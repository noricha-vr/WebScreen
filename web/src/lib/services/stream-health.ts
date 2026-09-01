import type { StreamHealthResponse } from '../contracts/api';
import type { MediaMtxClient } from '../infra/mediamtx';
import { getStreamStatus, type StreamDatabase } from './streams';

/** 所有確認済みの ingress / egress path から relay 到達状態を返す。 */
export async function getStreamHealth(input: {
  database: StreamDatabase;
  userId: number;
  id: string;
  ingress: MediaMtxClient;
  egress: MediaMtxClient;
}): Promise<StreamHealthResponse> {
  await getStreamStatus({ database: input.database, userId: input.userId, id: input.id });
  const pathName = `live/${input.id}`;
  const [ingress, egress] = await Promise.all([
    input.ingress.getPath(pathName),
    input.egress.getPath(pathName),
  ]);
  const ingressBytes = ingress?.bytesReceived ?? 0;
  const egressBytes = egress?.bytesReceived ?? 0;
  return {
    state: ingress && egress && ingressBytes > 0 && egressBytes > 0 ? 'ready' : 'starting',
    ingressBytes,
    egressBytes,
    audioDetected: null,
  };
}
