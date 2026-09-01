import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import {
  ERROR_CODES,
  MAX_UPLOAD_BYTES,
  validateAbandonUploadRequest,
  validatePresignRequest,
  type PresignRequest,
} from '../../src/lib/contracts/api';
import {
  MAX_PENDING_UPLOADS_PER_USER,
  USER_STORAGE_QUOTA_BYTES,
  getUserStorageUsage,
} from '../../src/lib/services/quota';
import {
  commitUpload,
  createPendingUpload,
  type UploadBucket,
  type UploadDatabase,
} from '../../src/lib/services/uploads';

const USER_ID = 10;
const PUBLIC_URL = 'https://public.example';

/** bun:sqlite を D1 のサービス境界へ合わせる最小アダプター。 */
class SqliteD1Adapter implements UploadDatabase {
  constructor(readonly sqlite: Database) {}

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        first: async <T>(): Promise<T | null> =>
          (this.sqlite.query(query).get(...(values as SQLQueryBindings[])) as T | null) ?? null,
        all: async <T>(): Promise<{ results: T[] }> => ({
          results: this.sqlite.query(query).all(...(values as SQLQueryBindings[])) as T[],
        }),
        run: async (): Promise<{ meta: { changes: number } }> => {
          const result = this.sqlite.query(query).run(...(values as SQLQueryBindings[]));
          return { meta: { changes: result.changes } };
        },
      }),
    };
  }
}

/** 実際の初期 migration を適用した、テストごとに独立なD1代替を作る。 */
async function createDatabase(): Promise<SqliteD1Adapter> {
  const sqlite = new Database(':memory:');
  sqlite.exec(await Bun.file(new URL('../../migrations/0001_init.sql', import.meta.url)).text());
  sqlite.query('INSERT INTO users (id, discord_id, name) VALUES (?, ?, ?)').run(USER_ID, '10', 'tester');
  return new SqliteD1Adapter(sqlite);
}

async function insertMovie(
  database: SqliteD1Adapter,
  input: {
    shortId: string;
    sizeBytes: number;
    status?: 'pending' | 'ready' | 'failed';
    userId?: number;
  }
): Promise<void> {
  database.sqlite
    .query(
      "INSERT INTO movies (short_id, user_id, filename, size_bytes, status, expires_at) VALUES (?, ?, 'movie.mp4', ?, ?, ?)"
    )
    .run(
      input.shortId,
      input.userId ?? USER_ID,
      input.sizeBytes,
      input.status ?? 'pending',
      '2026-09-24T00:00:00.000Z'
    );
}

function validPresignRequest(sizeBytes = 100): PresignRequest {
  return { filename: 'movie.mp4', sizeBytes, kind: 'pdf' };
}

function uploadInput(database: UploadDatabase, shortId: string, sizeBytes = 100) {
  return {
    database,
    userId: USER_ID,
    request: validPresignRequest(sizeBytes),
    publicBaseUrl: PUBLIC_URL,
    createUploadUrl: async () => 'https://upload.example',
    generateId: () => shortId,
  };
}

class SizedBucket implements UploadBucket {
  constructor(private readonly sizes: ReadonlyMap<string, number>) {}

  async head(key: string): Promise<{ size: number } | null> {
    const size = this.sizes.get(key);
    return size === undefined ? null : { size };
  }
}

async function releaseTogether<T>(operations: Array<() => Promise<T>>): Promise<PromiseSettledResult<T>[]> {
  let arrived = 0;
  let release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  return Promise.allSettled(
    operations.map(async (operation) => {
      arrived += 1;
      if (arrived === operations.length) release?.();
      await barrier;
      return operation();
    })
  );
}

describe('アップロードのクォータと検証', () => {
  it('500 MiB ちょうどまで、pending 分を含めて予約できる', async () => {
    const database = await createDatabase();
    await insertMovie(database, { shortId: 'Existing00001', sizeBytes: USER_STORAGE_QUOTA_BYTES - 100 });

    await expect(createPendingUpload(uploadInput(database, 'ZyXwVu987654'))).resolves.toMatchObject({
      shortId: 'ZyXwVu987654',
    });
    expect(await getUserStorageUsage(database, USER_ID)).toBe(USER_STORAGE_QUOTA_BYTES);
  });

  it('500 MiB を超える予約を 413 で拒否する', async () => {
    const database = await createDatabase();
    await insertMovie(database, { shortId: 'Existing00001', sizeBytes: USER_STORAGE_QUOTA_BYTES });

    await expect(createPendingUpload(uploadInput(database, 'ZyXwVu987654', 1))).rejects.toMatchObject({
      status: 413,
    });
  });

  it('残り 1 件分の容量へ 2 件を並行予約しても片方だけを確保する', async () => {
    const database = await createDatabase();
    await insertMovie(database, {
      shortId: 'Existing00001',
      sizeBytes: USER_STORAGE_QUOTA_BYTES - 100,
      status: 'ready',
    });

    const results = await releaseTogether([
      () => createPendingUpload(uploadInput(database, 'Concurrent01')),
      () => createPendingUpload(uploadInput(database, 'Concurrent02')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
      status: 413,
    });
    expect(await getUserStorageUsage(database, USER_ID)).toBe(USER_STORAGE_QUOTA_BYTES);
  });

  it('pending は10件まで予約でき、同じawait境界の11件目を429で拒否する', async () => {
    const database = await createDatabase();
    const results = await releaseTogether(
      Array.from({ length: MAX_PENDING_UPLOADS_PER_USER + 1 }, (_, index) => () =>
        createPendingUpload(uploadInput(database, `Pending${String(index).padStart(5, '0')}`))
      )
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(MAX_PENDING_UPLOADS_PER_USER);
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
      status: 429,
      errorCode: ERROR_CODES.tooManyPendingUploads,
    });
  });

  it('同じユーザーの並行commitは実測サイズ込みの上限で片方だけreadyにする', async () => {
    const database = await createDatabase();
    const declaredSize = 25 * 1024 * 1024;
    const actualSize = declaredSize * 2;
    await insertMovie(database, { shortId: 'Existing00001', sizeBytes: 401 * 1024 * 1024, status: 'ready' });
    await insertMovie(database, { shortId: 'CommitOne001', sizeBytes: declaredSize });
    await insertMovie(database, { shortId: 'CommitTwo001', sizeBytes: declaredSize });
    const bucket = new SizedBucket(
      new Map([
        ['movies/CommitOne001.mp4', actualSize],
        ['movies/CommitTwo001.mp4', actualSize],
      ])
    );

    const results = await releaseTogether(['CommitOne001', 'CommitTwo001'].map((shortId) => () =>
      commitUpload({ database, bucket, userId: USER_ID, shortId, publicBaseUrl: PUBLIC_URL })
    ));

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({
      status: 413,
    });
    const statuses = database.sqlite
      .query("SELECT status FROM movies WHERE short_id LIKE 'Commit%' ORDER BY short_id")
      .all() as Array<{ status: string }>;
    expect(statuses.map((row) => row.status).sort()).toEqual(['failed', 'ready']);
  });

  it('署名 URL の発行に失敗したら pending 行を残さない', async () => {
    const database = await createDatabase();
    await expect(
      createPendingUpload({
        ...uploadInput(database, 'ZyXwVu987654'),
        createUploadUrl: async () => {
          throw new Error('signing failed');
        },
      })
    ).rejects.toThrow('signing failed');
    expect(await getUserStorageUsage(database, USER_ID)).toBe(0);
  });

  it('51 MiB と未定義の kind を presign 前に拒否する', () => {
    expect(validatePresignRequest({ ...validPresignRequest(MAX_UPLOAD_BYTES + 1) }).ok).toBe(false);
    expect(validatePresignRequest({ ...validPresignRequest(), kind: 'audio' }).ok).toBe(false);
  });

  it('failed を含め、短い ID の abandon リクエストは拒否する', () => {
    expect(validateAbandonUploadRequest({ shortId: 'AbCdEf123456' }).ok).toBe(true);
    expect(validateAbandonUploadRequest({ shortId: 'short' }).ok).toBe(false);
  });
});
