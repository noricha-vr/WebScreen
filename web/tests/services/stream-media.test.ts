import { describe, expect, it } from 'bun:test';

import type { MediaMtxClient, MediaMtxPublisher } from '../../src/lib/infra/mediamtx';
import { createStreamMediaMtxClients } from '../../src/lib/services/stream-media';

function fakeClient(): MediaMtxClient {
  return {
    listPaths: async () => [],
    kickPublisher: async (_publisher: MediaMtxPublisher) => undefined,
  };
}

describe('MediaMTX endpoint wiring', () => {
  it('split endpointを旧単一endpointより優先してingress/egressを別clientへ渡す', () => {
    const configured: string[] = [];
    const clients = createStreamMediaMtxClients(
      {
        legacyApiUrl: 'https://legacy.example',
        legacyApiToken: 'legacy-token',
        ingressApiUrl: 'https://ingress.example',
        ingressApiToken: 'ingress-token',
        egressApiUrl: 'https://egress.example',
        egressApiToken: 'egress-token',
      },
      (config) => {
        configured.push(config.apiUrl);
        return fakeClient();
      }
    );
    expect(clients?.ingress).not.toBe(clients?.egress);
    expect(configured).toEqual(['https://ingress.example', 'https://egress.example']);
  });

  it('split endpointが未設定なら旧単一endpointを両roleへ互換利用する', () => {
    const clients = createStreamMediaMtxClients(
      { legacyApiUrl: 'https://legacy.example', legacyApiToken: 'legacy-token' },
      () => fakeClient()
    );
    expect(clients?.ingress).toBe(clients?.egress);
  });
});
