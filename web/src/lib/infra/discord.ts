const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_CURRENT_USER_URL = 'https://discord.com/api/users/@me';
const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';

/** Discord API へ注入する fetch 境界。 */
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const defaultFetch: Fetcher = (input, init) => globalThis.fetch(input, init);

/** Discord OAuth から取得した、保存に必要なプロフィール。 */
export interface DiscordIdentity {
  id: string;
  name: string;
  avatar: string | null;
}

/** Discord API が失敗したことを、レスポンス本文を漏らさず通知する。 */
export class DiscordApiError extends Error {
  constructor(operation: string, status?: number) {
    super(status === undefined ? `${operation} failed` : `${operation} failed (${status})`);
    this.name = 'DiscordApiError';
  }
}

/** identify scope の Discord 認可 URL を組み立てる。 */
export function createDiscordAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string
): string {
  const url = new URL(DISCORD_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('scope', 'identify');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

/** authorization code を交換し、Discord の現在ユーザーを取得する。 */
export async function fetchDiscordIdentity(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  fetcher: Fetcher = defaultFetch
): Promise<DiscordIdentity> {
  const tokenResponse = await safeFetch(
    fetcher,
    DISCORD_TOKEN_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
    },
    'Discord token exchange'
  );
  const token = await readJson(tokenResponse, 'Discord token response');
  if (!isString(token.access_token) || !isString(token.token_type)) {
    throw new DiscordApiError('Discord token response');
  }

  const userResponse = await safeFetch(
    fetcher,
    DISCORD_CURRENT_USER_URL,
    { headers: { Authorization: `${token.token_type} ${token.access_token}` } },
    'Discord user request'
  );
  const user = await readJson(userResponse, 'Discord user response');
  if (
    !isString(user.id) ||
    !isString(user.username) ||
    (user.global_name !== null && user.global_name !== undefined && !isString(user.global_name)) ||
    (user.avatar !== null && user.avatar !== undefined && !isString(user.avatar))
  ) {
    throw new DiscordApiError('Discord user response');
  }

  return {
    id: user.id,
    name: isString(user.global_name) ? user.global_name : user.username,
    avatar: isString(user.avatar) ? user.avatar : null,
  };
}

async function safeFetch(
  fetcher: Fetcher,
  input: RequestInfo | URL,
  init: RequestInit,
  operation: string
): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(input, init);
  } catch {
    throw new DiscordApiError(operation);
  }
  if (!response.ok) throw new DiscordApiError(operation, response.status);
  return response;
}

async function readJson(response: Response, operation: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new DiscordApiError(operation);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DiscordApiError(operation);
  }
  return value as Record<string, unknown>;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
