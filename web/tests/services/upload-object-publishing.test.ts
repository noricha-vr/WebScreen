import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';

import { movieKey, temporaryUploadKey } from '../../src/lib/contracts/r2key';
import { deleteMovie } from '../../src/lib/services/movies';
import {
  commitUpload,
  createPendingUpload,
  type UploadBucket,
  type UploadDatabase,
} from '../../src/lib/services/uploads';

const USER_ID = 137;
const SHORT_ID = 'Hardening137';
const PUBLIC_BASE_URL = 'https://cdn.example';

class SqliteD1Adapter implements UploadDatabase {
  onReadyUpdate: (() => void) | undefined;

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
          if (result.changes === 1 && query.includes("SET status = 'ready'")) {
            this.onReadyUpdate?.();
          }
          return { meta: { changes: result.changes } };
        },
      }),
    };
  }
}

class RacingUploadBucket implements UploadBucket {
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();
  private getCount = 0;
  private putCount = 0;
  private releaseSecondPut: (() => void) | undefined;
  private readonly secondPutBarrier = new Promise<void>((resolve) => {
    this.releaseSecondPut = resolve;
  });

  constructor(private readonly generations: [Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>]) {}

  async get(): Promise<{ size: number; body: ReadableStream<Uint8Array> }> {
    const generation = this.generations[this.getCount];
    this.getCount += 1;
    if (!generation) throw new Error('unexpected get');
    return { size: generation.byteLength, body: new Blob([generation]).stream() };
  }

  async head(key: string): Promise<{ size: number } | null> {
    const value = this.objects.get(key);
    return value ? { size: value.byteLength } : null;
  }

  async put(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: {
      httpMetadata: { contentType: string };
      onlyIf: { etagDoesNotMatch: '*' };
    }
  ): Promise<{ size: number } | null> {
    const call = this.putCount;
    this.putCount += 1;
    if (call === 1) await this.secondPutBarrier;
    if (options.onlyIf.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    const value = new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, value);
    return { size: value.byteLength };
  }

  async delete(): Promise<void> {}

  allowSecondPut(): void {
    this.releaseSecondPut?.();
  }
}

class MemoryUploadBucket implements UploadBucket {
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>();
  readonly deleted: string[] = [];
  readonly contentTypes = new Map<string, string>();
  readonly failingDeleteKeys = new Set<string>();
  failPut = false;
  onPut: (() => void) | undefined;

  async head(key: string): Promise<{ size: number } | null> {
    const value = this.objects.get(key);
    return value ? { size: value.byteLength } : null;
  }

  async get(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null> {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      size: value.byteLength,
      body: new Blob([value]).stream(),
    };
  }

  async put(
    key: string,
    body: ReadableStream<Uint8Array>,
    options: {
      httpMetadata: { contentType: string };
      onlyIf: { etagDoesNotMatch: '*' };
    }
  ): Promise<{ size: number } | null> {
    this.onPut?.();
    if (this.failPut) throw new Error('R2 put failed');
    if (options.onlyIf.etagDoesNotMatch === '*' && this.objects.has(key)) return null;
    const value = new Uint8Array(await new Response(body).arrayBuffer());
    this.objects.set(key, value);
    this.contentTypes.set(key, options.httpMetadata.contentType);
    return { size: value.byteLength };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (this.failingDeleteKeys.has(key)) throw new Error('R2 delete failed');
      this.objects.delete(key);
      this.deleted.push(key);
    }
  }
}

async function createDatabase(): Promise<SqliteD1Adapter> {
  const sqlite = new Database(':memory:');
  sqlite.exec(await Bun.file(new URL('../../migrations/0001_init.sql', import.meta.url)).text());
  sqlite
    .query('INSERT INTO users (id, discord_id, name) VALUES (?, ?, ?)')
    .run(USER_ID, String(USER_ID), 'tester');
  return new SqliteD1Adapter(sqlite);
}

async function reserve(database: UploadDatabase, signedKeys: string[]) {
  return createPendingUpload({
    database,
    userId: USER_ID,
    request: { filename: 'movie.mp4', sizeBytes: 100, kind: 'pdf' },
    publicBaseUrl: PUBLIC_BASE_URL,
    createUploadUrl: async (key) => {
      signedKeys.push(key);
      return `https://upload.example/${key}`;
    },
    generateId: () => SHORT_ID,
  });
}

function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

async function captureWarnEvents(run: () => Promise<void>): Promise<string[]> {
  const original = console.warn;
  const events: string[] = [];
  console.warn = ((entry: string) => events.push(JSON.parse(entry).event)) as typeof console.warn;
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return events;
}

describe('署名 PUT の一時キー公開', () => {
  it('tmp キーだけを署名し、publicUrl は movies キーのまま返す', async () => {
    const database = await createDatabase();
    const signedKeys: string[] = [];

    const response = await reserve(database, signedKeys);

    expect(signedKeys).toEqual([temporaryUploadKey(SHORT_ID)]);
    expect(response.publicUrl).toBe(`${PUBLIC_BASE_URL}/${movieKey(SHORT_ID)}`);
  });

  it('commit は tmp の bytes を公開キーへコピーして tmp を消す', async () => {
    const database = await createDatabase();
    const bucket = new MemoryUploadBucket();
    await reserve(database, []);
    bucket.objects.set(temporaryUploadKey(SHORT_ID), bytes(1, 2, 3));

    await commitUpload({
      database,
      bucket,
      userId: USER_ID,
      shortId: SHORT_ID,
      publicBaseUrl: PUBLIC_BASE_URL,
    });

    expect(bucket.objects.get(movieKey(SHORT_ID))).toEqual(bytes(1, 2, 3));
    expect(bucket.contentTypes.get(movieKey(SHORT_ID))).toBe('video/mp4');
    expect(bucket.objects.has(temporaryUploadKey(SHORT_ID))).toBe(false);
  });

  it('commit 後に元署名先へ巨大再 PUT しても公開 bytes と D1 size は変わらない', async () => {
    const database = await createDatabase();
    const bucket = new MemoryUploadBucket();
    await reserve(database, []);
    bucket.objects.set(temporaryUploadKey(SHORT_ID), bytes(1, 2, 3));
    await commitUpload({
      database,
      bucket,
      userId: USER_ID,
      shortId: SHORT_ID,
      publicBaseUrl: PUBLIC_BASE_URL,
    });

    bucket.objects.set(temporaryUploadKey(SHORT_ID), new Uint8Array(1_000));

    expect(bucket.objects.get(movieKey(SHORT_ID))).toEqual(bytes(1, 2, 3));
    expect(
      database.sqlite.query('SELECT size_bytes FROM movies WHERE short_id = ?').get(SHORT_ID)
    ).toEqual({ size_bytes: 3 });
  });

  it('異なる tmp 世代を読んだ並行 commit でも最初の公開 bytes と D1 size を揃える', async () => {
    const database = await createDatabase();
    const firstGeneration = bytes(1, 2, 3);
    const secondGeneration = bytes(9, 9, 9, 9);
    const bucket = new RacingUploadBucket([firstGeneration, secondGeneration]);
    await reserve(database, []);
    database.onReadyUpdate = () => bucket.allowSecondPut();

    await Promise.all([
      commitUpload({
        database,
        bucket,
        userId: USER_ID,
        shortId: SHORT_ID,
        publicBaseUrl: PUBLIC_BASE_URL,
      }),
      commitUpload({
        database,
        bucket,
        userId: USER_ID,
        shortId: SHORT_ID,
        publicBaseUrl: PUBLIC_BASE_URL,
      }),
    ]);

    expect(bucket.objects.get(movieKey(SHORT_ID))).toEqual(firstGeneration);
    expect(
      database.sqlite.query('SELECT size_bytes FROM movies WHERE short_id = ?').get(SHORT_ID)
    ).toEqual({ size_bytes: firstGeneration.byteLength });
  });

  it('曖昧失敗で公開 object だけ残っていても上書きせず、その実測サイズで ready 化する', async () => {
    const database = await createDatabase();
    const bucket = new MemoryUploadBucket();
    const existingPublished = bytes(7, 7);
    await reserve(database, []);
    bucket.objects.set(temporaryUploadKey(SHORT_ID), bytes(1, 2, 3));
    bucket.objects.set(movieKey(SHORT_ID), existingPublished);

    const result = await commitUpload({
      database,
      bucket,
      userId: USER_ID,
      shortId: SHORT_ID,
      publicBaseUrl: PUBLIC_BASE_URL,
    });

    expect(result.sizeBytes).toBe(existingPublished.byteLength);
    expect(bucket.objects.get(movieKey(SHORT_ID))).toEqual(existingPublished);
    expect(
      database.sqlite.query('SELECT status, size_bytes FROM movies WHERE short_id = ?').get(SHORT_ID)
    ).toEqual({ status: 'ready', size_bytes: existingPublished.byteLength });
  });

  it('ready DELETE 後に元署名先へ再 PUT しても公開 movie は復活しない', async () => {
    const database = await createDatabase();
    const bucket = new MemoryUploadBucket();
    await reserve(database, []);
    bucket.objects.set(temporaryUploadKey(SHORT_ID), bytes(1, 2, 3));
    await commitUpload({
      database,
      bucket,
      userId: USER_ID,
      shortId: SHORT_ID,
      publicBaseUrl: PUBLIC_BASE_URL,
    });
    await deleteMovie({
      database,
      bucket,
      userId: USER_ID,
      shortId: SHORT_ID,
      cachePurge: {
        publicBaseUrl: PUBLIC_BASE_URL,
        zoneId: '',
        apiToken: '',
        source: 'test',
      },
    });

    bucket.objects.set(temporaryUploadKey(SHORT_ID), bytes(9, 9, 9));

    expect(bucket.objects.has(movieKey(SHORT_ID))).toBe(false);
    expect(database.sqlite.query('SELECT short_id FROM movies WHERE short_id = ?').get(SHORT_ID)).toBeNull();
  });

  it('公開 put が失敗したら pending と tmp を残し、公開 object を作らない', async () => {
    const database = await createDatabase();
    const bucket = new MemoryUploadBucket();
    await reserve(database, []);
    bucket.objects.set(temporaryUploadKey(SHORT_ID), bytes(1, 2, 3));
    bucket.failPut = true;

    await expect(
      commitUpload({
        database,
        bucket,
        userId: USER_ID,
        shortId: SHORT_ID,
        publicBaseUrl: PUBLIC_BASE_URL,
      })
    ).rejects.toThrow('R2 put failed');

    expect(bucket.objects.has(temporaryUploadKey(SHORT_ID))).toBe(true);
    expect(bucket.objects.has(movieKey(SHORT_ID))).toBe(false);
    expect(database.sqlite.query('SELECT status FROM movies WHERE short_id = ?').get(SHORT_ID)).toEqual({
      status: 'pending',
    });
  });

  it('公開コピー後に D1 の failed 確保と競合したら公開コピーだけを戻す', async () => {
    const database = await createDatabase();
    const bucket = new MemoryUploadBucket();
    await reserve(database, []);
    bucket.objects.set(temporaryUploadKey(SHORT_ID), bytes(1, 2, 3));
    bucket.onPut = () => {
      database.sqlite
        .query("UPDATE movies SET status = 'failed' WHERE short_id = ?")
        .run(SHORT_ID);
    };

    await expect(
      commitUpload({
        database,
        bucket,
        userId: USER_ID,
        shortId: SHORT_ID,
        publicBaseUrl: PUBLIC_BASE_URL,
      })
    ).rejects.toMatchObject({ status: 400 });

    expect(bucket.objects.has(movieKey(SHORT_ID))).toBe(false);
    expect(bucket.objects.has(temporaryUploadKey(SHORT_ID))).toBe(true);
    expect(database.sqlite.query('SELECT status FROM movies WHERE short_id = ?').get(SHORT_ID)).toEqual({
      status: 'failed',
    });
  });

  it('ready 化後の tmp cleanup 失敗を記録し、ready DELETE で再回収する', async () => {
    const database = await createDatabase();
    const bucket = new MemoryUploadBucket();
    const temporaryKey = temporaryUploadKey(SHORT_ID);
    await reserve(database, []);
    bucket.objects.set(temporaryKey, bytes(1, 2, 3));
    bucket.failingDeleteKeys.add(temporaryKey);

    const events = await captureWarnEvents(async () => {
      await commitUpload({
        database,
        bucket,
        userId: USER_ID,
        shortId: SHORT_ID,
        publicBaseUrl: PUBLIC_BASE_URL,
      });
    });

    expect(events).toEqual(['upload_tmp_cleanup_failed']);
    expect(bucket.objects.has(temporaryKey)).toBe(true);
    expect(bucket.objects.has(movieKey(SHORT_ID))).toBe(true);

    bucket.failingDeleteKeys.clear();
    await deleteMovie({
      database,
      bucket,
      userId: USER_ID,
      shortId: SHORT_ID,
      cachePurge: {
        publicBaseUrl: PUBLIC_BASE_URL,
        zoneId: '',
        apiToken: '',
        source: 'test',
      },
    });
    expect(bucket.objects.has(temporaryKey)).toBe(false);
    expect(bucket.objects.has(movieKey(SHORT_ID))).toBe(false);
  });

  it('競合時の公開 cleanup 失敗を記録し、failed sweep が両キーを追跡できる状態を残す', async () => {
    const database = await createDatabase();
    const bucket = new MemoryUploadBucket();
    const publicKey = movieKey(SHORT_ID);
    await reserve(database, []);
    bucket.objects.set(temporaryUploadKey(SHORT_ID), bytes(1, 2, 3));
    bucket.onPut = () => {
      database.sqlite
        .query("UPDATE movies SET status = 'failed' WHERE short_id = ?")
        .run(SHORT_ID);
    };
    bucket.failingDeleteKeys.add(publicKey);

    const events = await captureWarnEvents(async () => {
      await expect(
        commitUpload({
          database,
          bucket,
          userId: USER_ID,
          shortId: SHORT_ID,
          publicBaseUrl: PUBLIC_BASE_URL,
        })
      ).rejects.toMatchObject({ status: 400 });
    });

    expect(events).toEqual(['upload_public_cleanup_failed']);
    expect(bucket.objects.has(publicKey)).toBe(true);
    expect(bucket.objects.has(temporaryUploadKey(SHORT_ID))).toBe(true);
    expect(database.sqlite.query('SELECT status FROM movies WHERE short_id = ?').get(SHORT_ID)).toEqual({
      status: 'failed',
    });
  });
});
