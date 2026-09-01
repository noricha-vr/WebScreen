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
  egress: MediaMtxClient;
}

export interface StreamMediaMtxSettings {
  legacyApiUrl?: string;
  legacyApiToken?: string;
  ingressApiUrl?: string;
  ingressApiToken?: string;
  egressApiUrl?: string;
  egressApiToken?: string;
}

/** ingress / egress 優先、旧単一 Control API をfallbackにして client を組み立てる。 */
export function createStreamMediaMtxClients(
  settings: StreamMediaMtxSettings,
  createClient: (config: { apiUrl: string; apiToken: string }) => MediaMtxClient =
    createStreamMediaMtxClient
): StreamMediaMtxClients | undefined {
  const usesSplitEndpoints = Boolean(
    settings.ingressApiUrl ||
      settings.ingressApiToken ||
      settings.egressApiUrl ||
      settings.egressApiToken
  );
  if (usesSplitEndpoints) {
    return {
      ingress: createEndpoint(settings.ingressApiUrl, settings.ingressApiToken, 'INGRESS', createClient),
      egress: createEndpoint(settings.egressApiUrl, settings.egressApiToken, 'EGRESS', createClient),
    };
  }
  if (!settings.legacyApiUrl && !settings.legacyApiToken) return undefined;
  const legacy = createEndpoint(settings.legacyApiUrl, settings.legacyApiToken, 'legacy', createClient);
  return { ingress: legacy, egress: legacy };
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
