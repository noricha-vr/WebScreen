/** lifecycle service が扱う MediaMTX path の最小表現。 */
export interface MediaPath {
  name: string;
  publisherId: string | null;
  rtspReaders: number;
}

export interface MediaMtxClient {
  listPaths(): Promise<MediaPath[]>;
  kickPublisher(publisherId: string): Promise<void>;
}

export type MediaMtxFetch = typeof fetch;

const MAX_PAGE_COUNT = 1000;

/** MediaMTX v3 Control API の HTTP adapter を作る。 */
export function createMediaMtxClient(config: {
  apiUrl: string;
  apiToken: string;
  fetchImpl?: MediaMtxFetch;
}): MediaMtxClient {
  const baseUrl = normalizeBaseUrl(config.apiUrl);
  const fetchImpl = config.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${config.apiToken}` };

  return {
    async listPaths(): Promise<MediaPath[]> {
      const first = await fetchPage(fetchImpl, baseUrl, headers, 0);
      const paths = first.items.map(parsePath);
      for (let page = 1; page < first.pageCount; page += 1) {
        const next = await fetchPage(fetchImpl, baseUrl, headers, page);
        if (next.pageCount !== first.pageCount) throw new Error('MediaMTX page count changed');
        paths.push(...next.items.map(parsePath));
      }
      return paths;
    },
    async kickPublisher(publisherId: string): Promise<void> {
      const response = await fetchImpl(
        `${baseUrl}/v3/webrtcsessions/kick/${encodeURIComponent(publisherId)}`,
        { method: 'POST', headers }
      );
      if (!response.ok) throw new Error(`MediaMTX kick failed with status ${response.status}`);
    },
  };
}

interface PageResponse {
  pageCount: number;
  items: unknown[];
}

async function fetchPage(
  fetchImpl: MediaMtxFetch,
  baseUrl: string,
  headers: Record<string, string>,
  page: number
): Promise<PageResponse> {
  const response = await fetchImpl(`${baseUrl}/v3/paths/list?page=${page}`, { headers });
  if (!response.ok) throw new Error(`MediaMTX path list failed with status ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('MediaMTX path list returned invalid JSON');
  }
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new Error('MediaMTX path list response is malformed');
  }
  const pageCount = body.pageCount;
  if (
    !Number.isInteger(pageCount) ||
    (pageCount as number) < 0 ||
    (pageCount as number) > MAX_PAGE_COUNT
  ) {
    throw new Error('MediaMTX path list pageCount is invalid');
  }
  return { pageCount: pageCount as number, items: body.items };
}

function parsePath(value: unknown): MediaPath {
  if (!isRecord(value) || typeof value.name !== 'string' || !Array.isArray(value.readers)) {
    throw new Error('MediaMTX path item is malformed');
  }
  const source = isRecord(value.source) ? value.source : null;
  const publisherId =
    source?.type === 'webRTCSession' && typeof source.id === 'string' ? source.id : null;
  const rtspReaders = value.readers.filter(
    (reader) => isRecord(reader) && reader.type === 'rtspSession'
  ).length;
  return { name: value.name, publisherId, rtspReaders };
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  // #126 でホストが未確定なので固定 allowlist は置かない。代わりに資格情報の送信先を
  // HTTPS origin のみに制限し、URL の曖昧な構成要素をすべて拒否する。
  if (url.protocol !== 'https:') {
    throw new Error('MEDIAMTX_API_URL must use HTTPS');
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('MEDIAMTX_API_URL must be an HTTPS origin without credentials or path');
  }
  return url.toString().replace(/\/$/, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
