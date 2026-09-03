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
    const egresses = settings.readEgressApiUrls
      ? createReadEgresses(settings.readEgressApiUrls, settings.egressApiToken, createClient)
      : [createEndpoint(settings.egressApiUrl, settings.egressApiToken, 'EGRESS', createClient)];
    return {
      ingress,
      egress: egresses[0] as MediaMtxClient,
      egresses,
    };
  }
  if (!settings.legacyApiUrl && !settings.legacyApiToken) return undefined;
  const legacy = createEndpoint(settings.legacyApiUrl, settings.legacyApiToken, 'legacy', createClient);
  return { ingress: legacy, egress: legacy, egresses: [legacy] };
}

function createReadEgresses(
  value: string,
  apiToken: string | undefined,
  createClient: (config: { apiUrl: string; apiToken: string }) => MediaMtxClient
): MediaMtxClient[] {
  const apiUrls = value.split(',').map((apiUrl) => apiUrl.trim());
  if (apiUrls.length === 0 || apiUrls.some((apiUrl) => apiUrl.length === 0)) {
    throw new Error('MEDIAMTX_READ_EGRESS_API_URLS must contain one or more URLs');
  }
  return [...new Set(apiUrls)].map((apiUrl) =>
    createEndpoint(apiUrl, apiToken, 'READ_EGRESS', createClient)
  );
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
