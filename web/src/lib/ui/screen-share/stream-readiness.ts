import type { VideoPublishStats, WhipPublisher } from '../whip-publisher';

export interface PublisherReadiness {
  ready: boolean;
  stats: VideoPublishStats | null;
}

/** health 成功を現 publisher の映像送出量で検証する。 */
export async function publisherReadiness(
  publisher: WhipPublisher,
  healthReady: boolean
): Promise<PublisherReadiness> {
  const stats = await publisher.videoStats();
  return { ready: healthReady && stats?.bytesSent !== 0, stats };
}
