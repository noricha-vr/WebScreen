import { createMediaMtxClient, type MediaMtxClient } from '../infra/mediamtx';

/** cron entrypoint が infra へ直接依存せず MediaMTX adapter を組み立てる公開口。 */
export function createStreamMediaMtxClient(config: {
  apiUrl: string;
  apiToken: string;
}): MediaMtxClient {
  return createMediaMtxClient(config);
}

export interface StreamMediaMtxClients {
  ingress: MediaMtxClient;
  /** origin egress。health API はこの client だけを使う。 */
  egress: MediaMtxClient;
  /** viewer 判定で観測する origin を含むすべての read egress。 */
  egresses: MediaMtxClient[];
  /** 日次転送量を集計する read egress。nodeKey は Control API URL の host。 */
  readNodes: Array<{ nodeKey: string; client: MediaMtxClient }>;
}

export interface StreamMediaMtxSettings {
  legacyApiUrl?: string;
  legacyApiToken?: string;
  ingressApiUrl?: string;
  ingressApiToken?: string;
  egressApiUrl?: string;
  egressApiToken?: string;
  readEgressApiUrls?: string;
}

/** ingress / read egress 優先、旧単一 Control API をfallbackにして client を組み立てる。 */
export function createStreamMediaMtxClients(
  settings: StreamMediaMtxSettings,
  createClient: (config: { apiUrl: string; apiToken: string }) => MediaMtxClient =
    createStreamMediaMtxClient
): StreamMediaMtxClients | undefined {
  const usesSplitEndpoints = Boolean(
    settings.ingressApiUrl ||
      settings.ingressApiToken ||
      settings.egressApiUrl ||
      settings.egressApiToken ||
      settings.readEgressApiUrls
  );
  if (usesSplitEndpoints) {
    const ingress = createEndpoint(
      settings.ingressApiUrl,
      settings.ingressApiToken,
      'INGRESS',
      createClient
    );
    // origin egress は MEDIAMTX_EGRESS_API_URL が正。read 一覧はそれに replica を足したもので、
    // 一覧だけが設定された場合のみ先頭を origin と見なす（health API が replica を見る誤配線を防ぐ）。
    const readApiUrls = settings.readEgressApiUrls
      ? parseReadEgressApiUrls(settings.readEgressApiUrls)
      : [];
    const originApiUrl = settings.egressApiUrl ?? readApiUrls[0];
    const egress = createEndpoint(originApiUrl, settings.egressApiToken, 'EGRESS', createClient);
    const readEndpoints = [
      { apiUrl: originApiUrl, client: egress },
      ...readApiUrls
        .filter((apiUrl) => apiUrl !== originApiUrl)
        .map((apiUrl) => ({
          apiUrl,
          client: createEndpoint(apiUrl, settings.egressApiToken, 'READ_EGRESS', createClient),
        })),
    ];
    return {
      ingress,
      egress,
      egresses: readEndpoints.map((endpoint) => endpoint.client),
      readNodes: readEndpoints.map((endpoint) => ({
        nodeKey: new URL(endpoint.apiUrl).host,
        client: endpoint.client,
      })),
    };
  }
  if (!settings.legacyApiUrl && !settings.legacyApiToken) return undefined;
  if (!settings.legacyApiUrl || !settings.legacyApiToken) {
    throw new Error('MediaMTX legacy API URL and token are both required');
  }
  const legacy = createEndpoint(settings.legacyApiUrl, settings.legacyApiToken, 'legacy', createClient);
  return {
    ingress: legacy,
    egress: legacy,
    egresses: [legacy],
    readNodes: [{ nodeKey: new URL(settings.legacyApiUrl).host, client: legacy }],
  };
}

/** カンマ区切りの read egress URL を、空要素（末尾カンマ等）を拒否して重複なしで返す。 */
function parseReadEgressApiUrls(value: string): string[] {
  const apiUrls = value.split(',').map((apiUrl) => apiUrl.trim().replace(/\/+$/, ''));
  const emptyIndex = apiUrls.findIndex((apiUrl) => apiUrl.length === 0);
  if (emptyIndex !== -1) {
    throw new Error(`MEDIAMTX_READ_EGRESS_API_URLS has an empty entry at index ${emptyIndex}`);
  }
  return [...new Set(apiUrls)];
}

function createEndpoint(
  apiUrl: string | undefined,
  apiToken: string | undefined,
  name: string,
  createClient: (config: { apiUrl: string; apiToken: string }) => MediaMtxClient
): MediaMtxClient {
  if (!apiUrl || !apiToken) throw new Error(`MediaMTX ${name} API URL and token are both required`);
  return createClient({ apiUrl, apiToken });
}
