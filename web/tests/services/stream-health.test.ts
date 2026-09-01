import { describe, expect, it } from 'bun:test';

import type { MediaMtxClient, MediaMtxPublisher, MediaPath } from '../../src/lib/infra/mediamtx';
import { getStreamHealth } from '../../src/lib/services/stream-health';
import { createStreamDatabase } from './helpers/stream-db';

class FakeMediaMtx implements MediaMtxClient {
  constructor(private readonly paths: MediaPath[]) {}
  async listPaths(): Promise<MediaPath[]> {
    return this.paths;
  }
  async kickPublisher(_publisher: MediaMtxPublisher): Promise<void> {}
}

async function insertStream(): Promise<Awaited<ReturnType<typeof createStreamDatabase>>> {
  const database = await createStreamDatabase();
  database.sqlite
    .query(
      `INSERT INTO stream_sessions (
        id, user_id, status, started_at, extend_expires_at, last_heartbeat_at, last_viewer_at
      ) VALUES ('AbCdEf123456', 10, 'live', ?, ?, ?, ?)`
    )
    .run(
      '2026-09-01T00:00:00.000Z',
      '2026-09-01T02:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z'
    );
  return database;
}

describe('stream health', () => {
  it('片方のpathまたはbytesが未到達ならstartingを返す', async () => {
    const database = await insertStream();
    const health = await getStreamHealth({
      database,
      userId: 10,
      id: 'AbCdEf123456',
      ingress: new FakeMediaMtx([
        { name: 'live/AbCdEf123456', publisherId: 'publisher', rtspReaders: 0, bytesReceived: 32 },
      ]),
      egress: new FakeMediaMtx([]),
    });
    expect(health).toEqual({
      state: 'starting',
      ingressBytes: 32,
      egressBytes: 0,
      audioDetected: null,
    });
  });

  it('所有者に両pathのbytes到達をreadyとして返し、他人には404を返す', async () => {
    const database = await insertStream();
    const ingress = new FakeMediaMtx([
      { name: 'live/AbCdEf123456', publisherId: 'publisher', rtspReaders: 0, bytesReceived: 32 },
    ]);
    const egress = new FakeMediaMtx([
      { name: 'live/AbCdEf123456', publisherId: 'relay', rtspReaders: 0, bytesReceived: 16 },
    ]);
    await expect(
      getStreamHealth({ database, userId: 10, id: 'AbCdEf123456', ingress, egress })
    ).resolves.toEqual({
      state: 'ready',
      ingressBytes: 32,
      egressBytes: 16,
      audioDetected: null,
    });
    await expect(
      getStreamHealth({ database, userId: 20, id: 'AbCdEf123456', ingress, egress })
    ).rejects.toMatchObject({ status: 404 });
  });
});
