import { describe, expect, it } from 'bun:test';

import type { MediaMtxClient, MediaMtxPublisher } from '../../src/lib/infra/mediamtx';
import { createStreamMediaMtxClients } from '../../src/lib/services/stream-media';

function fakeClient(): MediaMtxClient {
  return {
    getPath: async () => undefined,
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
    expect(clients?.egresses).toHaveLength(1);
    expect(configured).toEqual(['https://ingress.example', 'https://egress.example']);
  });

  it('read egress一覧を個別clientへ展開し、先頭をorigin egressとして返す', () => {
    const configured: string[] = [];
    const clients = createStreamMediaMtxClients(
      {
        ingressApiUrl: 'https://ingress.example',
        ingressApiToken: 'ingress-token',
        egressApiToken: 'egress-token',
        readEgressApiUrls: 'https://origin.example, https://replica.example',
      },
      (config) => {
        configured.push(config.apiUrl);
        return fakeClient();
      }
    );

    expect(clients?.egress).toBe(clients?.egresses[0]);
    expect(clients?.egresses).toHaveLength(2);
    expect(configured).toEqual([
      'https://ingress.example',
      'https://origin.example',
      'https://replica.example',
    ]);
  });

  it('MEDIAMTX_EGRESS_API_URL があれば read 一覧の順序に関わらず origin egress として優先し重複を除く', () => {
    const configured: string[] = [];
    const clients = createStreamMediaMtxClients(
      {
        ingressApiUrl: 'https://ingress.example',
        ingressApiToken: 'ingress-token',
        egressApiUrl: 'https://origin.example',
        egressApiToken: 'egress-token',
        readEgressApiUrls: 'https://replica.example, https://origin.example/',
      },
      (config) => {
        configured.push(config.apiUrl);
        return fakeClient();
      }
    );

    expect(clients?.egress).toBe(clients?.egresses[0]);
    expect(clients?.egresses).toHaveLength(2);
    expect(configured).toEqual([
      'https://ingress.example',
      'https://origin.example',
      'https://replica.example',
    ]);
  });

  it('read 一覧の空要素（末尾カンマ）は位置付きで拒否する', () => {
    expect(() =>
      createStreamMediaMtxClients(
        {
          ingressApiUrl: 'https://ingress.example',
          ingressApiToken: 'ingress-token',
          egressApiToken: 'egress-token',
          readEgressApiUrls: 'https://origin.example,',
        },
        () => fakeClient()
      )
    ).toThrow('empty entry at index 1');
  });

  it('split endpointが未設定なら旧単一endpointを両roleへ互換利用する', () => {
    const clients = createStreamMediaMtxClients(
      { legacyApiUrl: 'https://legacy.example', legacyApiToken: 'legacy-token' },
      () => fakeClient()
    );
    expect(clients?.ingress).toBe(clients?.egress);
    expect(clients?.egresses).toHaveLength(1);
    expect(clients?.egresses[0]).toBe(clients?.egress);
  });
});
