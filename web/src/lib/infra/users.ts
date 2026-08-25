/** D1 の users テーブルから返すログインユーザー。 */
export interface AuthUser {
  id: number;
  discordId: string;
  name: string;
  avatar: string | null;
}

/** テスト可能な D1 prepared statement の最小境界。 */
export interface UserStatement {
  bind(...values: unknown[]): UserStatement;
  first<T>(): Promise<T | null>;
}

/** users の読み書きに必要な D1 binding の最小境界。 */
export interface UsersDatabase {
  prepare(query: string): UserStatement;
}

interface UserRow {
  id: number;
  discord_id: string;
  name: string;
  avatar: string | null;
}

/** Discord ID をキーにユーザーを作成またはプロフィール更新する。 */
export async function upsertDiscordUser(
  db: UsersDatabase,
  discordId: string,
  name: string,
  avatar: string | null
): Promise<AuthUser> {
  const row = await db
    .prepare(
      `INSERT INTO users (discord_id, name, avatar)
       VALUES (?, ?, ?)
       ON CONFLICT(discord_id) DO UPDATE SET
         name = excluded.name,
         avatar = excluded.avatar
       RETURNING id, discord_id, name, avatar`
    )
    .bind(discordId, name, avatar)
    .first<UserRow>();

  if (!row) throw new Error('users upsert did not return a row');
  return mapUser(row);
}

/** users.id からログインユーザーを取得する。 */
export async function findUserById(db: UsersDatabase, id: number): Promise<AuthUser | null> {
  const row = await db
    .prepare('SELECT id, discord_id, name, avatar FROM users WHERE id = ?')
    .bind(id)
    .first<UserRow>();

  return row ? mapUser(row) : null;
}

function mapUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    discordId: row.discord_id,
    name: row.name,
    avatar: row.avatar,
  };
}
