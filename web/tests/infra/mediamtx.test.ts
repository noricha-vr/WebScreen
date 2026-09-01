import { describe, expect, it } from 'bun:test';

import { createMediaMtxClient } from '../../src/lib/infra/mediamtx';

describe('MediaMTX Control API adapter', () => {
  it('全pageを走査しRTSP readerだけを数え、WebRTC publisherを読む', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('Authorization'),
      });
      const page = url.endsWith('page=0')
        ? {
            pageCount: 2,
            items: [
              {
                name: 'live/AbCdEf123456',
                source: { type: 'webRTCSession', id: 'publisher-1' },
                readers: [{ type: 'rtspSession' }, { type: 'hlsMuxer' }],
              },
            ],
          }
        : {
            pageCount: 2,
            items: [{ name: 'live/ZyXwVu987654', source: null, readers: [] }],
          };
      return Response.json(page);
    };
    const client = createMediaMtxClient({
      apiUrl: 'https://media.example/',
      apiToken: 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await client.listPaths()).toEqual([
      {
        name: 'live/AbCdEf123456',
        publisherId: 'publisher-1',
        publisherSessionType: 'webRTCSession',
        rtspReaders: 1,
        bytesReceived: 0,
        bytesSent: 0,
      },
      {
        name: 'live/ZyXwVu987654',
        publisherId: null,
        publisherSessionType: null,
        rtspReaders: 0,
        bytesReceived: 0,
        bytesSent: 0,
      },
    ]);
    expect(requests.map((request) => request.url)).toEqual([
      'https://media.example/v3/paths/list?page=0',
      'https://media.example/v3/paths/list?page=1',
    ]);
    expect(requests.every((request) => request.authorization === 'Bearer test-token')).toBe(true);
  });

  it('kickはpublisher IDをpathへ入れ、非2xxを例外にする', async () => {
    const fetchImpl = async () => new Response(null, { status: 503 });
    const client = createMediaMtxClient({
      apiUrl: 'https://media.example',
      apiToken: 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.kickPublisher({ id: 'publisher/unsafe', sessionType: 'webRTCSession' })
    ).rejects.toThrow('status 503');
  });

  it('RTSP publisherにはRTSP session kickを使い、404は冪等に成功する', async () => {
    const requests: string[] = [];
    const client = createMediaMtxClient({
      apiUrl: 'https://media.example',
      apiToken: 'test-token',
      fetchImpl: (async (input: string | URL | Request) => {
        requests.push(String(input));
        return new Response(null, { status: 404 });
      }) as unknown as typeof fetch,
    });
    await expect(
      client.kickPublisher({ id: 'relay-1', sessionType: 'rtspSession' })
    ).resolves.toBeUndefined();
    expect(requests).toEqual(['https://media.example/v3/rtspsessions/kick/relay-1']);
  });

  it('不正なlist応答を例外にして握り潰さない', async () => {
    const client = createMediaMtxClient({
      apiUrl: 'https://media.example',
      apiToken: 'test-token',
      fetchImpl: (async () =>
        Response.json({ pageCount: 1, items: [{ name: 1 }] })) as unknown as typeof fetch,
    });
    await expect(client.listPaths()).rejects.toThrow('malformed');
  });

  it('pathが0件のpageCount=0を空一覧として受理する', async () => {
    const client = createMediaMtxClient({
      apiUrl: 'https://media.example',
      apiToken: 'test-token',
      fetchImpl: (async () =>
        Response.json({ pageCount: 0, items: [] })) as unknown as typeof fetch,
    });
    expect(await client.listPaths()).toEqual([]);
  });

  it.each([
    'http://media.example',
    'https://user:password@media.example',
    'https://media.example?target=other',
    'https://media.example#fragment',
    'https://media.example/control',
  ])('Bearer送信先として安全でないURLを拒否する: %s', (apiUrl) => {
    expect(() =>
      createMediaMtxClient({ apiUrl, apiToken: 'test-token' })
    ).toThrow('MEDIAMTX_API_URL');
  });

  it('pageCountが合理的な上限を超えたら走査せず失敗する', async () => {
    const client = createMediaMtxClient({
      apiUrl: 'https://media.example',
      apiToken: 'test-token',
      fetchImpl: (async () =>
        Response.json({ pageCount: 1001, items: [] })) as unknown as typeof fetch,
    });
    await expect(client.listPaths()).rejects.toThrow('pageCount');
  });
});
