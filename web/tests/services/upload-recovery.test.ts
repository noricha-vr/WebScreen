import { describe, expect, it } from 'bun:test';

import { movieKey } from '../../src/lib/contracts/r2key';
import { PRESIGN_TTL_MS } from '../../src/lib/infra/r2presign';
import { runRetention, type RetentionBucket, type RetentionDatabase } from '../../src/lib/services/retention';
import { USER_STORAGE_QUOTA_BYTES, type QuotaDatabase } from '../../src/lib/services/quota';
import {
  abandonUpload,
  commitUpload,
  createPendingUpload,
  type UploadBucket,
  type UploadDatabase,
} from '../../src/lib/services/uploads';

type Status = 'pending' | 'ready' | 'failed';

interface RecoveryMovie {
  shortId: string;
  userId: number;
  filename: string;
  sizeBytes: number;
  status: Status;
  createdAt: string;
  expiresAt: string | null;
}

class RecoveryDatabase implements UploadDatabase, RetentionDatabase, QuotaDatabase {
  readonly movies = new Map<string, RecoveryMovie>();

  constructor(private readonly createdAt: string) {}

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        first: async <T>(): Promise<T | null> => this.first<T>(query, values),
        all: async <T>(): Promise<{ results: T[] }> => ({ results: this.all<T>(query, values) }),
        run: async (): Promise<{ meta: { changes: number } }> => ({
          meta: { changes: this.run(query, values) },
        }),
      }),
    };
  }

  private first<T>(query: string, values: unknown[]): T | null {
    if (query.startsWith('SELECT COALESCE')) {
      const [userId] = values as [number];
      const statuses = parseUsageStatuses(query);
      const total = [...this.movies.values()]
        .filter((movie) => movie.userId === userId && statuses.has(movie.status))
        .reduce((sum, movie) => sum + movie.sizeBytes, 0);
      return { total } as T;
    }

    const movie = this.movies.get(values[0] as string);
    if (!movie || movie.userId !== values[1]) return null;
    return {
      short_id: movie.shortId,
      user_id: movie.userId,
      size_bytes: movie.sizeBytes,
      status: movie.status,
      expires_at: movie.expiresAt,
    } as T;
  }

  private all<T>(query: string, values: unknown[]): T[] {
    if (!query.includes("status = 'failed'")) return [];
    const lowerCutoff = Date.parse(values[0] as string);
    const upperCutoff = query.includes('datetime(created_at) >= datetime(?)')
      ? Date.parse(values[1] as string)
      : undefined;
    return [...this.movies.values()]
      .filter((movie) => {
        if (movie.status !== 'failed') return false;
        const createdAt = Date.parse(movie.createdAt);
        return upperCutoff === undefined
          ? createdAt < lowerCutoff
          : createdAt >= lowerCutoff && createdAt < upperCutoff;
      })
      .map((movie) => ({ short_id: movie.shortId }) as T);
  }

  private run(query: string, values: unknown[]): number {
    if (query.startsWith('INSERT INTO movies')) {
      const [shortId, userId, filename, sizeBytes, expiresAt] = values as [
        string,
        number,
        string,
        number,
        string,
      ];
      this.movies.set(shortId, {
        shortId,
        userId,
        filename,
        sizeBytes,
        status: 'pending',
        createdAt: this.createdAt,
        expiresAt,
      });
      return 1;
    }

    if (query.startsWith('UPDATE') && query.includes('short_id IN (')) {
      const [sweptAt, ...shortIds] = values as [string, ...string[]];
      let changes = 0;
      for (const shortId of shortIds) {
        const movie = this.movies.get(shortId);
        if (!movie || movie.status !== 'failed') continue;
        movie.expiresAt = sweptAt;
        changes += 1;
      }
      return changes;
    }

    if (query.startsWith('DELETE') && query.includes('short_id IN (')) {
      const ids = values as string[];
      for (const shortId of ids) this.movies.delete(shortId);
      return ids.length;
    }

    if (!query.includes("SET status = 'failed'")) return 0;
    const updatesSize = query.includes('size_bytes = ?');
    const [sizeBytes, shortId, userId] = updatesSize
      ? (values as [number, string, number])
      : ([undefined, ...values] as [undefined, string, number]);
    const movie = this.movies.get(shortId);
    if (!movie || movie.userId !== userId || movie.status !== 'pending') return 0;
    movie.status = 'failed';
    if (sizeBytes !== undefined) movie.sizeBytes = sizeBytes;
    return 1;
  }
}

function parseUsageStatuses(query: string): Set<Status> {
  const clause = query.match(/status\s+IN\s*\(([^)]+)\)/i)?.[1];
  if (!clause) throw new Error(`quota query must filter statuses: ${query}`);
  return new Set([...clause.matchAll(/'([^']+)'/g)].map((match) => match[1] as Status));
}

class RecoveryBucket implements UploadBucket, RetentionBucket {
  readonly objects = new Map<string, number>();
  readonly deleted: string[] = [];
  onDelete: ((key: string) => void) | undefined;

  async head(key: string): Promise<{ size: number } | null> {
    const size = this.objects.get(key);
    return size === undefined ? null : { size };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.onDelete?.(key);
      this.objects.delete(key);
      this.deleted.push(key);
    }
  }

  async list(): Promise<{ objects: []; truncated: false }> {
    return { objects: [], truncated: false };
  }
}

const USER_ID = 7;
const CREATED_AT = new Date('2026-08-24T12:00:00.000Z');
const EARLY_RETENTION_TIME = new Date(CREATED_AT.getTime() + PRESIGN_TTL_MS + 60_001);
const PUBLIC_BASE_URL = 'https://cdn.example';

async function reserve(database: RecoveryDatabase, shortId: string, sizeBytes: number) {
  return createPendingUpload({
    database,
    userId: USER_ID,
    request: { filename: 'movie.mp4', sizeBytes, kind: 'image' },
    publicBaseUrl: PUBLIC_BASE_URL,
    createUploadUrl: async () => 'https://upload.example/presigned',
    generateId: () => shortId,
    now: CREATED_AT,
  });
}

async function retain(database: RecoveryDatabase, bucket: RecoveryBucket): Promise<void> {
  await runRetention({
    database,
    bucket,
    now: EARLY_RETENTION_TIME,
    cachePurge: {
      publicBaseUrl: PUBLIC_BASE_URL,
      zoneId: '2210192b51f9f0eb6761d70341ca09b0',
      apiToken: 'token',
      source: 'test',
      fetcher: async () => new Response(null, { status: 200 }),
    },
  });
}

describe('upload recovery', () => {
  it('ready + failed だけで上限なら次の presign を 413 で拒否する', async () => {
    const readyBytes = 300 * 1024 * 1024;
    const database = new RecoveryDatabase(CREATED_AT.toISOString());
    database.movies.set('readyQuota01', {
      shortId: 'readyQuota01',
      userId: USER_ID,
      filename: 'ready.mp4',
      sizeBytes: readyBytes,
      status: 'ready',
      createdAt: CREATED_AT.toISOString(),
      expiresAt: null,
    });
    database.movies.set('failedQuota1', {
      shortId: 'failedQuota1',
      userId: USER_ID,
      filename: 'failed.mp4',
      sizeBytes: USER_STORAGE_QUOTA_BYTES - readyBytes,
      status: 'failed',
      createdAt: CREATED_AT.toISOString(),
      expiresAt: null,
    });

    await expect(reserve(database, 'NextUpload01', 1)).rejects.toMatchObject({ status: 413 });
  });

  it('413後の再PUTを許容しつつ、cronがR2だけを早期回収する', async () => {
    const database = new RecoveryDatabase(CREATED_AT.toISOString());
    const bucket = new RecoveryBucket();
    const first = await reserve(database, 'FirstUpload1', 1);
    const key = movieKey(first.shortId);
    bucket.objects.set(key, 3);

    await expect(
      commitUpload({
        database,
        bucket,
        userId: USER_ID,
        shortId: first.shortId,
        publicBaseUrl: PUBLIC_BASE_URL,
      })
    ).rejects.toMatchObject({ status: 413 });
    expect(database.movies.get(first.shortId)).toMatchObject({ status: 'failed', sizeBytes: 3 });

    // 413 後にも同じ署名 URL へ 500 MiB の実体が届く。行は最初の HEAD 値 3 のまま。
    bucket.objects.set(key, USER_STORAGE_QUOTA_BYTES);
    await expect(reserve(database, 'NextUpload01', 1)).resolves.toMatchObject({ shortId: 'NextUpload01' });

    let rowExistedWhenObjectDeleted = false;
    bucket.onDelete = () => {
      rowExistedWhenObjectDeleted = database.movies.has(first.shortId);
    };
    await retain(database, bucket);
    expect(bucket.deleted).toContain(key);
    expect(rowExistedWhenObjectDeleted).toBe(true);
    expect(database.movies.get(first.shortId)?.status).toBe('failed');
  });

  it('abandon後の遅延PUTも同じfailed行を使い、cronがR2から先に回収する', async () => {
    const database = new RecoveryDatabase(CREATED_AT.toISOString());
    const bucket = new RecoveryBucket();
    const upload = await reserve(database, 'AbandonUp001', 1);
    const key = movieKey(upload.shortId);

    await abandonUpload({ database, userId: USER_ID, shortId: upload.shortId });
    bucket.objects.set(key, 3);
    expect(database.movies.get(upload.shortId)).toMatchObject({ status: 'failed', sizeBytes: 1 });

    let rowExistedWhenObjectDeleted = false;
    bucket.onDelete = () => {
      rowExistedWhenObjectDeleted = database.movies.has(upload.shortId);
    };
    await retain(database, bucket);
    expect(bucket.deleted).toContain(key);
    expect(rowExistedWhenObjectDeleted).toBe(true);
    expect(database.movies.get(upload.shortId)?.status).toBe('failed');
  });
});
