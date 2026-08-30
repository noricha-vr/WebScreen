import { describe, expect, it } from 'bun:test';

import { ERROR_CODES } from '../../src/lib/contracts/api';

import {
  MAX_PINNED_MOVIES,
  MOVIE_RETENTION_MS,
  PINNED_RETENTION_MS,
  UNPIN_GRACE_MS,
} from '../../src/lib/services/quota';
import type { CachePurgeSettings } from '../../src/lib/services/cache-purge';
import {
  deleteMovie,
  findPublicMovie,
  listHistory,
  renameMovie,
  togglePin,
  type MovieBucket,
  type MoviesDatabase,
} from '../../src/lib/services/movies';

type MovieStatus = 'pending' | 'ready' | 'failed';

interface TestMovie {
  shortId: string;
  userId: number;
  filename: string;
  status: MovieStatus;
  pinned: number;
  /** D1 の DEFAULT datetime('now') と同じ "YYYY-MM-DD HH:MM:SS"（UTC）で持つ。 */
  createdAt: string;
  expiresAt: string | null;
}

/** D1 binding の代役。SQL の先頭句で分岐し、実際の movies テーブルの挙動だけを真似る。 */
class FakeMoviesDatabase implements MoviesDatabase {
  readonly movies = new Map<string, TestMovie>();
  /** SQL 内の datetime('now') に相当する D1 側の時刻。テストから進められる。 */
  now = new Date('2026-08-30T00:00:00.000Z');
  /** pin の UPDATE 直前に走るフック。期限をまたぐ競合の再現に使う。 */
  onBeforePinUpdate: (() => void) | undefined;
  /** pin の UPDATE 直後に走るフック。0 件の理由を引き直す間の競合の再現に使う。 */
  onAfterPinUpdate: (() => void) | undefined;

  constructor(movies: TestMovie[] = []) {
    for (const movie of movies) this.movies.set(movie.shortId, { ...movie });
  }

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        first: async <T>(): Promise<T | null> => this.first<T>(query, values),
        all: async <T>(): Promise<{ results: T[] }> => ({ results: this.all<T>(query, values) }),
        run: async (): Promise<{ meta: { changes: number } }> => this.run(query, values),
      }),
    };
  }

  private first<T>(query: string, values: unknown[]): T | null {
    if (query.includes('AS expired')) {
      const [shortId, userId] = values as [string, number];
      const movie = this.movies.get(shortId);
      if (!movie || movie.userId !== userId) return null;
      return { expired: isPastExpiry(movie.expiresAt, this.now.toISOString()) ? 1 : 0 } as T;
    }

    if (query.includes('COUNT(*)')) {
      const userId = values[0] as number;
      const total = [...this.movies.values()].filter(
        (movie) => movie.userId === userId && movie.pinned === 1
      ).length;
      return { total } as T;
    }

    if (query.includes("status = 'ready'")) {
      const shortId = values[0] as string;
      const movie = this.movies.get(shortId);
      return movie && movie.status === 'ready' ? (toRow(movie) as T) : null;
    }

    const [shortId, userId] = values as [string, number];
    const movie = this.movies.get(shortId);
    return movie && movie.userId === userId ? (toRow(movie) as T) : null;
  }

  private all<T>(query: string, values: unknown[]): T[] {
    const [userId, limit] = values as [number, number];
    // 履歴は ready だけを返す。他の一覧クエリは failed を除くだけに留める。
    const isVisible = query.includes("status = 'ready'")
      ? (status: string) => status === 'ready'
      : (status: string) => status !== 'failed';
    return [...this.movies.values()]
      .filter((movie) => movie.userId === userId && isVisible(movie.status))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit)
      .map((movie) => toRow(movie) as T);
  }

  private run(query: string, values: unknown[]): { meta: { changes: number } } {
    if (query.startsWith('UPDATE movies SET filename')) {
      const [filename, shortId, userId] = values as [string, string, number];
      const movie = this.movies.get(shortId);
      if (movie && movie.userId === userId) movie.filename = filename;
      return { meta: { changes: movie && movie.userId === userId ? 1 : 0 } };
    }

    if (query.startsWith('UPDATE movies SET pinned')) {
      const [pinned, expiresAt, shortId, userId] = values as [number, string | null, string, number];
      // UPDATE の直前に走らせるフック（判定から書き込みまでの間の割り込みを再現する）
      this.onBeforePinUpdate?.();
      const movie = this.movies.get(shortId);
      // 判定に使う時刻は SQL の書き方で決まる。datetime('now') なら実行時点、
      // バインド値ならその値（実装が古い now を渡していれば、それがそのまま効く）。
      const threshold = query.includes("datetime('now')")
        ? this.now.toISOString()
        : ((values[4] as string | undefined) ?? this.now.toISOString());
      if (!movie || movie.userId !== userId || isPastExpiry(movie.expiresAt, threshold)) {
        this.onAfterPinUpdate?.();
        return { meta: { changes: 0 } };
      }
      // 件数の上限も WHERE で評価する。実装が読み取り側だけで判定していれば SQL に
      // 件数条件が現れないので、この分岐は素通りする（古い実装をそのまま再現する）。
      if (query.includes('SELECT COUNT(*)')) {
        const [countUserId, limit] = values.slice(4) as [number, number];
        if (pinnedCountOf(this, countUserId) >= limit) {
          this.onAfterPinUpdate?.();
          return { meta: { changes: 0 } };
        }
      }
      movie.pinned = pinned;
      movie.expiresAt = expiresAt;
      this.onAfterPinUpdate?.();
      return { meta: { changes: 1 } };
    }

    if (query.startsWith('DELETE FROM movies')) {
      const [shortId, userId] = values as [string, number];
      const movie = this.movies.get(shortId);
      if (movie && movie.userId === userId) this.movies.delete(shortId);
      return { meta: { changes: movie && movie.userId === userId ? 1 : 0 } };
    }

    return { meta: { changes: 0 } };
  }
}

class FakeMovieBucket implements MovieBucket {
  readonly deletedKeys: string[] = [];

  async delete(key: string): Promise<void> {
    this.deletedKeys.push(key);
  }
}

function toRow(movie: TestMovie) {
  return {
    short_id: movie.shortId,
    user_id: movie.userId,
    filename: movie.filename,
    status: movie.status,
    pinned: movie.pinned,
    created_at: movie.createdAt,
    expires_at: movie.expiresAt,
  };
}

const USER_ID = 10;
const SHORT_ID = 'AbCdEf123456';
const PUBLIC_URL = 'https://public.example';
const CREATED_AT = '2026-08-01 00:00:00';

/** 本番の datetime() 比較に相当する判定（秒精度・両表記を UTC として解釈する）。 */
function isPastExpiry(expiresAt: string | null, threshold: string): boolean {
  if (expiresAt === null) return false;
  const toMs = (value: string): number => {
    const normalized = value.includes('T') ? value : value.replace(' ', 'T');
    const parsed = Date.parse(/[Z+]|-\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
    return Math.floor(parsed / 1000) * 1000;
  };
  return toMs(expiresAt) < toMs(threshold);
}

function movie(overrides: Partial<TestMovie> = {}): TestMovie {
  return {
    shortId: SHORT_ID,
    userId: USER_ID,
    filename: 'slides.pdf',
    status: 'ready',
    pinned: 0,
    createdAt: CREATED_AT,
    expiresAt: '2026-08-31T00:00:00.000Z',
    ...overrides,
  };
}

function pinnedMovies(count: number): TestMovie[] {
  return Array.from({ length: count }, (_unused, index) =>
    movie({ shortId: `pinned${String(index).padStart(6, '0')}`, pinned: 1, expiresAt: null })
  );
}

/** そのユーザーが現在 pin している件数。上限を超えていないかの検証に使う。 */
function pinnedCountOf(database: FakeMoviesDatabase, userId: number): number {
  return [...database.movies.values()].filter(
    (candidate) => candidate.userId === userId && candidate.pinned === 1
  ).length;
}

describe('listHistory', () => {
  it('ready を新しい順に返し、日時を ISO8601 へ揃える', async () => {
    const database = new FakeMoviesDatabase([
      movie({ shortId: 'old000000001', createdAt: '2026-08-01 00:00:00' }),
      movie({ shortId: 'new000000002', createdAt: '2026-08-20 09:30:00' }),
    ]);

    const { movies } = await listHistory({ database, userId: USER_ID, publicBaseUrl: PUBLIC_URL });

    expect(movies.map((entry) => entry.shortId)).toEqual(['new000000002', 'old000000001']);
    expect(movies[0]).toMatchObject({
      status: 'ready',
      pinned: false,
      // "YYYY-MM-DD HH:MM:SS" は UTC。ローカル時刻として解釈すると実行環境でずれる
      createdAt: '2026-08-20T09:30:00.000Z',
      publicUrl: `${PUBLIC_URL}/movies/new000000002.mp4`,
    });
  });

  it('アップロード未完了（pending）は履歴に出さない', async () => {
    // 失敗した変換が誰にも failed へ落とされないまま「処理中」として残り続けていた。
    const database = new FakeMoviesDatabase([
      movie({ shortId: 'ready0000001' }),
      movie({ shortId: 'pending00001', status: 'pending' }),
    ]);

    const { movies } = await listHistory({ database, userId: USER_ID, publicBaseUrl: PUBLIC_URL });

    expect(movies.map((entry) => entry.shortId)).toEqual(['ready0000001']);
  });

  it('他人の動画は返さない', async () => {
    const database = new FakeMoviesDatabase([movie({ userId: USER_ID + 1 })]);

    const { movies } = await listHistory({ database, userId: USER_ID, publicBaseUrl: PUBLIC_URL });

    expect(movies).toEqual([]);
  });
});

describe('togglePin', () => {
  it('pin すると期限が今から 1 年後になる', async () => {
    const database = new FakeMoviesDatabase([movie()]);
    const now = new Date('2026-08-10T00:00:00.000Z');
    const expiresAt = new Date(now.getTime() + PINNED_RETENTION_MS).toISOString();

    await expect(
      togglePin({ database, userId: USER_ID, shortId: SHORT_ID, now })
    ).resolves.toEqual({
      shortId: SHORT_ID,
      pinned: true,
      expiresAt,
    });
    expect(database.movies.get(SHORT_ID)).toMatchObject({ pinned: 1, expiresAt });
  });

  it('pin し直すと期限がその時点から 1 年後へ延びる', async () => {
    const database = new FakeMoviesDatabase([movie()]);
    const pinnedAt = new Date('2026-08-10T00:00:00.000Z');
    const repinnedAt = new Date('2026-10-10T00:00:00.000Z');

    await togglePin({ database, userId: USER_ID, shortId: SHORT_ID, now: pinnedAt });
    await togglePin({ database, userId: USER_ID, shortId: SHORT_ID, now: repinnedAt });
    const response = await togglePin({
      database,
      userId: USER_ID,
      shortId: SHORT_ID,
      now: repinnedAt,
    });

    expect(response.pinned).toBe(true);
    expect(response.expiresAt).toBe(
      new Date(repinnedAt.getTime() + PINNED_RETENTION_MS).toISOString()
    );
  });

  it('pin 解除で作成から 30 日後の期限に戻る', async () => {
    const database = new FakeMoviesDatabase([movie({ pinned: 1, expiresAt: null })]);
    const now = new Date('2026-08-10T00:00:00.000Z');

    const response = await togglePin({ database, userId: USER_ID, shortId: SHORT_ID, now });

    expect(response.pinned).toBe(false);
    expect(response.expiresAt).toBe(
      new Date(Date.parse('2026-08-01T00:00:00.000Z') + MOVIE_RETENTION_MS).toISOString()
    );
  });

  it('復元した期限が過去になる場合は現在から 7 日後に伸ばす', async () => {
    const database = new FakeMoviesDatabase([movie({ pinned: 1, expiresAt: null })]);
    const now = new Date('2026-12-01T00:00:00.000Z');

    const response = await togglePin({ database, userId: USER_ID, shortId: SHORT_ID, now });

    expect(response.expiresAt).toBe(new Date(now.getTime() + UNPIN_GRACE_MS).toISOString());
  });

  it('pin が 10 件に達していると 409 で拒否する', async () => {
    const database = new FakeMoviesDatabase([...pinnedMovies(MAX_PINNED_MOVIES), movie()]);

    await expect(
      togglePin({ database, userId: USER_ID, shortId: SHORT_ID })
    ).rejects.toMatchObject({ status: 409 });
    expect(database.movies.get(SHORT_ID)?.pinned).toBe(0);
  });

  it('保管期限を過ぎた動画は pin できない', async () => {
    // 期限切れを終端の状態にしておかないと、保持期間バッチが R2 を消してから
    // D1 の行を消すまでの間に期限が延び、実体だけ消えた行が残る
    const now = new Date('2026-09-01T00:00:00.000Z');
    const database = new FakeMoviesDatabase([
      movie({ expiresAt: '2026-08-31T23:59:59.000Z' }),
    ]);
    database.now = now;

    await expect(
      togglePin({ database, userId: USER_ID, shortId: SHORT_ID, now })
    ).rejects.toMatchObject({ status: 410, errorCode: ERROR_CODES.expired });
    expect(database.movies.get(SHORT_ID)).toMatchObject({
      pinned: 0,
      expiresAt: '2026-08-31T23:59:59.000Z',
    });
  });

  it('保管期限を過ぎた動画は pin の解除もできない（解除も期限を延ばすため）', async () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    const database = new FakeMoviesDatabase([
      movie({ pinned: 1, expiresAt: '2026-08-31T23:59:59.000Z' }),
    ]);
    database.now = now;

    await expect(
      togglePin({ database, userId: USER_ID, shortId: SHORT_ID, now })
    ).rejects.toMatchObject({ status: 410, errorCode: ERROR_CODES.expired });
    expect(database.movies.get(SHORT_ID)).toMatchObject({ pinned: 1 });
  });

  it('判定の後・書き込みの前に期限が過ぎたら更新を通さない', async () => {
    // 読んでから書くまでの間にバッチが拾える状態になる順序。事前判定だけだと
    // ここで期限が延び、R2 の実体だけ消えた行が残る（Issue #83）
    const now = new Date('2026-09-01T00:00:00.000Z');
    const database = new FakeMoviesDatabase([movie({ expiresAt: '2026-09-01T00:00:10.000Z' })]);
    database.now = now;
    // 期限そのものは動かさず、書き込みまでに実時間が期限を越える
    database.onBeforePinUpdate = () => {
      database.now = new Date('2026-09-01T00:00:20.000Z');
    };

    await expect(
      togglePin({ database, userId: USER_ID, shortId: SHORT_ID, now })
    ).rejects.toMatchObject({ status: 410, errorCode: ERROR_CODES.expired });
    expect(database.movies.get(SHORT_ID)).toMatchObject({ pinned: 0 });
  });

  it('判定の後・書き込みの前に行が消えていたら 404 を返す', async () => {
    const now = new Date('2026-08-30T00:00:00.000Z');
    const database = new FakeMoviesDatabase([movie()]);
    database.onBeforePinUpdate = () => database.movies.delete(SHORT_ID);

    await expect(
      togglePin({ database, userId: USER_ID, shortId: SHORT_ID, now })
    ).rejects.toMatchObject({ status: 404, errorCode: ERROR_CODES.notFound });
  });

  it('期限ちょうどは断る（バッチより厳しい側に倒す）', async () => {
    // バッチの削除条件は expires_at < 閾値 なので、ちょうどの行はまだ消えない。
    // ここで通すと「延長できたのに次の実行で消える」わけではないが、判定の向きは
    // 常にバッチより厳しい側に寄せておく（緩い側に寄せると競合の余地ができる）。
    const expiresAt = '2026-09-01T00:00:00.000Z';
    const database = new FakeMoviesDatabase([movie({ expiresAt })]);
    database.now = new Date(expiresAt);

    await expect(
      togglePin({ database, userId: USER_ID, shortId: SHORT_ID, now: new Date(expiresAt) })
    ).rejects.toMatchObject({ status: 410 });
  });

  it('判定の後・書き込みの前に他の pin が確定したら上限を超えさせない', async () => {
    // 件数を読んでから書き込むまでの間に、別のリクエストが最後の枠を埋める順序。
    // 事前判定だけだと 11 件目が通り、1 ユーザーが上限を超えて 1 年間占有できる（Issue #85）
    const now = new Date('2026-08-10T00:00:00.000Z');
    const database = new FakeMoviesDatabase([
      ...pinnedMovies(MAX_PINNED_MOVIES - 1),
      movie({ shortId: 'other0000001' }),
      movie(),
    ]);
    database.onBeforePinUpdate = () => {
      const concurrent = database.movies.get('other0000001');
      if (concurrent) concurrent.pinned = 1;
    };

    await expect(
      togglePin({ database, userId: USER_ID, shortId: SHORT_ID, now })
    ).rejects.toMatchObject({ status: 409, errorCode: ERROR_CODES.invalidRequest });
    expect(database.movies.get(SHORT_ID)?.pinned).toBe(0);
    expect(pinnedCountOf(database, USER_ID)).toBe(MAX_PINNED_MOVIES);
  });

  it('残り 2 枠へ 3 本を並行させても 2 本しか通らない', async () => {
    const now = new Date('2026-08-10T00:00:00.000Z');
    const shortIds = ['race00000001', 'race00000002', 'race00000003'];
    const database = new FakeMoviesDatabase([
      ...pinnedMovies(MAX_PINNED_MOVIES - 2),
      ...shortIds.map((shortId) => movie({ shortId })),
    ]);

    const results = await Promise.allSettled(
      shortIds.map((shortId) => togglePin({ database, userId: USER_ID, shortId, now }))
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect(pinnedCountOf(database, USER_ID)).toBe(MAX_PINNED_MOVIES);
  });

  it('上限で弾いた直後に枠が空いても 409 のまま返す', async () => {
    // 0 件の理由を件数の再集計で決めると、弾かれた直後の解除で 9 件に見えて 410 に化ける。
    // 呼び出し側（ui/preview-actions.ts）は 409 と 410 で別の文言を出すので誤案内になる。
    const now = new Date('2026-08-10T00:00:00.000Z');
    const database = new FakeMoviesDatabase([
      ...pinnedMovies(MAX_PINNED_MOVIES - 1),
      movie({ shortId: 'other0000001' }),
      movie(),
    ]);
    database.onBeforePinUpdate = () => {
      const concurrent = database.movies.get('other0000001');
      if (concurrent) concurrent.pinned = 1;
    };
    database.onAfterPinUpdate = () => {
      const released = database.movies.get('pinned000000');
      if (released) released.pinned = 0;
    };

    await expect(
      togglePin({ database, userId: USER_ID, shortId: SHORT_ID, now })
    ).rejects.toMatchObject({ status: 409, errorCode: ERROR_CODES.invalidRequest });
  });

  it('期限切れと上限到達が重なったら期限切れ（410）を優先する', async () => {
    // 理由の判定にリクエスト開始時の now を使うと、書き込みの直前に過ぎた期限を見落として
    // 409 を返す。期限切れは終端の状態なので、D1 の時刻で判定して 410 を優先する。
    const now = new Date('2026-09-01T00:00:00.000Z');
    const database = new FakeMoviesDatabase([
      ...pinnedMovies(MAX_PINNED_MOVIES - 1),
      movie({ shortId: 'other0000001', expiresAt: null }),
      movie({ expiresAt: '2026-09-01T00:00:10.000Z' }),
    ]);
    database.now = now;
    database.onBeforePinUpdate = () => {
      const concurrent = database.movies.get('other0000001');
      if (concurrent) concurrent.pinned = 1;
      database.now = new Date('2026-09-01T00:00:20.000Z');
    };

    await expect(
      togglePin({ database, userId: USER_ID, shortId: SHORT_ID, now })
    ).rejects.toMatchObject({ status: 410, errorCode: ERROR_CODES.expired });
  });

  it('9 件なら 10 件目を pin できる', async () => {
    const database = new FakeMoviesDatabase([...pinnedMovies(MAX_PINNED_MOVIES - 1), movie()]);

    await expect(
      togglePin({ database, userId: USER_ID, shortId: SHORT_ID })
    ).resolves.toMatchObject({ pinned: true });
  });

  it('上限に達していても pin 解除はできる', async () => {
    const database = new FakeMoviesDatabase(pinnedMovies(MAX_PINNED_MOVIES));

    await expect(
      togglePin({ database, userId: USER_ID, shortId: 'pinned000000' })
    ).resolves.toMatchObject({ pinned: false });
  });

  it('他人の動画は 404 で拒否する', async () => {
    const database = new FakeMoviesDatabase([movie({ userId: USER_ID + 1 })]);

    await expect(
      togglePin({ database, userId: USER_ID, shortId: SHORT_ID })
    ).rejects.toMatchObject({ status: 404 });
    expect(database.movies.get(SHORT_ID)?.pinned).toBe(0);
  });
});

describe('renameMovie', () => {
  it('所有者のファイル名を変更する', async () => {
    const database = new FakeMoviesDatabase([movie()]);

    await expect(
      renameMovie({ database, userId: USER_ID, shortId: SHORT_ID, filename: 'renamed.mp4' })
    ).resolves.toEqual({ shortId: SHORT_ID, filename: 'renamed.mp4' });
    expect(database.movies.get(SHORT_ID)?.filename).toBe('renamed.mp4');
  });

  it('他人の動画は 404 で拒否する', async () => {
    const database = new FakeMoviesDatabase([movie({ userId: USER_ID + 1 })]);

    await expect(
      renameMovie({ database, userId: USER_ID, shortId: SHORT_ID, filename: 'renamed.mp4' })
    ).rejects.toMatchObject({ status: 404 });
  });

  it('不在の動画は 404 で拒否する', async () => {
    const database = new FakeMoviesDatabase();

    await expect(
      renameMovie({ database, userId: USER_ID, shortId: SHORT_ID, filename: 'renamed.mp4' })
    ).rejects.toMatchObject({ status: 404 });
  });
});

/** キャッシュ purge の設定。ここでは purge の挙動を見ないので送信だけ止める。 */
const CACHE_PURGE: CachePurgeSettings = {
  publicBaseUrl: 'https://cdn.example',
  zoneId: '2210192b51f9f0eb6761d70341ca09b0',
  apiToken: 'test-token',
  source: 'test-worker',
  fetcher: () => Promise.resolve(new Response(null, { status: 200 })),
};

describe('deleteMovie', () => {
  it('R2 の実体を消してから D1 の行を消す', async () => {
    const database = new FakeMoviesDatabase([movie()]);
    const bucket = new FakeMovieBucket();

    await deleteMovie({ database, bucket, cachePurge: CACHE_PURGE, userId: USER_ID, shortId: SHORT_ID });

    expect(bucket.deletedKeys).toEqual([`movies/${SHORT_ID}.mp4`]);
    expect(database.movies.has(SHORT_ID)).toBe(false);
  });

  it('他人の動画は 404 で拒否し、R2 にも触らない', async () => {
    const database = new FakeMoviesDatabase([movie({ userId: USER_ID + 1 })]);
    const bucket = new FakeMovieBucket();

    await expect(
      deleteMovie({ database, bucket, cachePurge: CACHE_PURGE, userId: USER_ID, shortId: SHORT_ID })
    ).rejects.toMatchObject({ status: 404 });
    expect(bucket.deletedKeys).toEqual([]);
    expect(database.movies.has(SHORT_ID)).toBe(true);
  });

  it('shortId の形式が不正なら DB を引く前に 404 で止める', async () => {
    const database = new FakeMoviesDatabase([movie()]);
    const bucket = new FakeMovieBucket();

    await expect(
      deleteMovie({ database, bucket, cachePurge: CACHE_PURGE, userId: USER_ID, shortId: '../../etc/passwd' })
    ).rejects.toMatchObject({ status: 404 });
    expect(bucket.deletedKeys).toEqual([]);
  });
});

describe('findPublicMovie', () => {
  it('ready の動画を公開 URL 付きで返す', async () => {
    const database = new FakeMoviesDatabase([movie()]);

    await expect(
      findPublicMovie({ database, shortId: SHORT_ID, publicBaseUrl: PUBLIC_URL })
    ).resolves.toMatchObject({
      shortId: SHORT_ID,
      filename: 'slides.pdf',
      publicUrl: `${PUBLIC_URL}/movies/${SHORT_ID}.mp4`,
      pinned: false,
      ownerId: USER_ID,
    });
  });

  it('pending / failed は公開しない', async () => {
    for (const status of ['pending', 'failed'] as const) {
      const database = new FakeMoviesDatabase([movie({ status })]);

      await expect(
        findPublicMovie({ database, shortId: SHORT_ID, publicBaseUrl: PUBLIC_URL })
      ).resolves.toBeNull();
    }
  });

  it.each([
    ['ja', '短すぎる'],
    ['abcdefghijklm', '長すぎる'],
    ['AbCdEf-12345', '記号を含む'],
    ['../../etc/pw', 'パス区切りを含む'],
  ])('%s（%s）は DB を引かずに null', async (shortId) => {
    const database = new FakeMoviesDatabase([movie()]);

    await expect(
      findPublicMovie({ database, shortId: shortId as string, publicBaseUrl: PUBLIC_URL })
    ).resolves.toBeNull();
  });
});
