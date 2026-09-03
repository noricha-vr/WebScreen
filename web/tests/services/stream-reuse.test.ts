import { describe, expect, it } from 'bun:test';

import { ERROR_CODES } from '../../src/lib/contracts/api';
import { createStream, stopStream, type StreamSettings } from '../../src/lib/services/streams';
import { createStreamDatabase } from './helpers/stream-db';

const NOW = new Date('2026-09-01T00:00:00.000Z');
const SETTINGS: StreamSettings = {
  extensionCycleSeconds: 7200,
  maxLiveStreamsPerUser: 1,
  maxLiveStreams: 20,
  createIntervalSeconds: 10,
};
const START_TOKEN = '22222222-2222-4222-9222-222222222222';
const signer = async ({ expiresAtSeconds }: { expiresAtSeconds: number }) => `token-exp-${expiresAtSeconds}`;

function input(database: Awaited<ReturnType<typeof createStreamDatabase>>, id: string, now = NOW) {
  return { database, userId: 10, settings: SETTINGS, signPublishToken: signer, generateId: () => id, now };
}

describe('配信 ID の再利用', () => {
  it('所有する終了済み ID を再利用し、時刻・token・停止待ち状態を更新する', async () => {
    const database = await createStreamDatabase();
    await createStream(input(database, 'AbCdEf123456'));
    await stopStream({ database, userId: 10, id: 'AbCdEf123456', now: NOW });
    const resumedAt = new Date(NOW.getTime() + 11_000);

    const response = await createStream({
      ...input(database, 'ignored00000', resumedAt), reuseId: 'AbCdEf123456', startToken: START_TOKEN,
    });

    expect(response).toMatchObject({
      id: 'AbCdEf123456', streamUrl: 'rtspt://webscreen.tv/live/AbCdEf123456',
      startedAt: resumedAt.toISOString(), publishToken: `token-exp-${Date.parse(response.extendExpiresAt) / 1000}`,
    });
    expect(
      database.sqlite.query('SELECT status, ended_at, end_reason, kick_pending, start_token FROM stream_sessions').get()
    ).toEqual({ status: 'live', ended_at: null, end_reason: null, kick_pending: 0, start_token: START_TOKEN });
  });

  it.each([
    ['他人の ID', 20, 'AbCdEf123456'],
    ['live 中の ID', 10, 'AbCdEf123456'],
    ['存在しない ID', 10, 'Missing00001'],
  ])('%s の再利用は ID の状態を漏らさず拒否する', async (_label, userId, reuseId) => {
    const database = await createStreamDatabase();
    await createStream(input(database, 'AbCdEf123456'));
    if (userId === 20) await stopStream({ database, userId: 10, id: 'AbCdEf123456', now: NOW });

    await expect(
      createStream({ ...input(database, 'ignored00000', new Date(NOW.getTime() + 11_000)), userId, reuseId })
    ).rejects.toMatchObject({ status: 409, errorCode: ERROR_CODES.streamIdNotReusable });
  });

  it('不正な再利用 ID は service 境界でも400として拒否する', async () => {
    const database = await createStreamDatabase();

    await expect(createStream({ ...input(database, 'ignored00000'), reuseId: 'invalid-id' }))
      .rejects.toMatchObject({ status: 400, errorCode: ERROR_CODES.invalidRequest });
  });
});
