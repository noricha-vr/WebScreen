/** lifecycle service が扱う MediaMTX path の最小表現。 */
export interface MediaPath {
  name: string;
  publisherId: string | null;
  publisherSessionType?: MediaMtxSessionType | null;
  rtspReaders: number;
  bytesReceived?: number;
  bytesSent?: number;
}

export type MediaMtxSessionType = 'webRTCSession' | 'rtspSession';

export interface MediaMtxPublisher {
  id: string;
  sessionType: MediaMtxSessionType;
}

export interface MediaMtxClient {
  getPath(name: string): Promise<MediaPath | undefined>;
  listPaths(): Promise<MediaPath[]>;
  kickPublisher(publisher: MediaMtxPublisher): Promise<void>;
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
    async getPath(name: string): Promise<MediaPath | undefined> {
      const response = await fetchImpl(
        `${baseUrl}/v3/paths/get/${encodeURIComponent(name)}`,
        { headers }
      );
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`MediaMTX path get failed with status ${response.status}`);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error('MediaMTX path get returned invalid JSON');
      }
      return parsePath(body);
    },
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
    async kickPublisher(publisher: MediaMtxPublisher): Promise<void> {
      const sessionPath =
        publisher.sessionType === 'webRTCSession' ? 'webrtcsessions' : 'rtspsessions';
      const response = await fetchImpl(
        `${baseUrl}/v3/${sessionPath}/kick/${encodeURIComponent(publisher.id)}`,
        { method: 'POST', headers }
      );
      if (response.status === 404) return;
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
  const publisherSessionType = sessionType(source?.type);
  const publisherId = publisherSessionType && typeof source?.id === 'string' ? source.id : null;
  const rtspReaders = value.readers.filter(
    (reader) => isRecord(reader) && reader.type === 'rtspSession'
  ).length;
  return {
    name: value.name,
    publisherId,
    publisherSessionType: publisherId ? publisherSessionType : null,
    rtspReaders,
    bytesReceived: nonNegativeNumber(value.bytesReceived),
    bytesSent: nonNegativeNumber(value.bytesSent),
  };
}

function sessionType(value: unknown): MediaMtxSessionType | null {
  return value === 'webRTCSession' || value === 'rtspSession' ? value : null;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
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
