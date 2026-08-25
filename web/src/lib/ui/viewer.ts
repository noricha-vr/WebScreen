/**
 * `GET /api/me/` のレスポンスから、ヘッダー表示に必要な最小限だけを取り出す。
 *
 * このエンドポイントの payload はまだ契約（docs/api-contracts.md）で凍結されていない。
 * そのため「ログイン判定は HTTP ステータス、表示名とアバターは在れば使う」という
 * 読み方に閉じ、欠けていても画面が壊れないようにする。形が確定したら
 * contracts 側の型を import する形に置き換える。
 */

export interface Viewer {
  name: string | null;
  avatarUrl: string | null;
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** アバターは絶対 URL のときだけ採用する。 */
function readHttpUrl(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = readString(record, key);
    if (value === null) continue;

    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.toString();
    } catch {
      // 絶対 URL でなければ次の候補キーを見る
    }
  }
  return null;
}

/** Discord のユーザー ID と avatar hash から CDN URL を組み立てる。 */
function readDiscordAvatarUrl(record: Record<string, unknown>): string | null {
  const discordId = readString(record, 'discordId');
  const avatar = readString(record, 'avatar');
  if (discordId === null || avatar === null) return null;
  return `https://cdn.discordapp.com/avatars/${encodeURIComponent(discordId)}/${encodeURIComponent(avatar)}.png`;
}

export function parseViewer(payload: unknown): Viewer {
  const record = asRecord(payload);
  if (!record) return { name: null, avatarUrl: null };

  const user = asRecord(record['user']) ?? record;

  return {
    name: readString(user, 'name') ?? readString(user, 'username'),
    avatarUrl: readHttpUrl(user, ['avatarUrl']) ?? readDiscordAvatarUrl(user),
  };
}

/** アバター画像が無いときに表示する頭文字。名前が無ければサービス名の頭文字。 */
export function viewerInitial(viewer: Viewer): string {
  const source = viewer.name ?? 'W';
  return [...source][0]!.toUpperCase();
}
