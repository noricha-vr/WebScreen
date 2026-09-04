import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';

import { E2E_FIXTURES } from '../playwright.config';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
);

interface UploadObservation {
  preflightHeaders: Readonly<Record<string, string | string[] | undefined>>[];
  putContentTypes: string[];
  putBodies: Buffer[];
  putStatuses: number[];
}

interface UploadServer {
  readonly observation: UploadObservation;
  readonly uploadUrl: string;
  allowOrigin(origin: string): void;
  close(): Promise<void>;
}

function writeCorsHeaders(response: ServerResponse, allowedOrigin: string | null): void {
  if (allowedOrigin === null) return;
  response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  response.setHeader('Access-Control-Allow-Methods', 'PUT');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  response.setHeader('Access-Control-Expose-Headers', 'ETag');
}

function handleUpload(
  request: IncomingMessage,
  response: ServerResponse,
  observation: UploadObservation,
  allowedOrigin: string | null,
  putStatus: 200 | 403
): void {
  if (request.method === 'OPTIONS') {
    observation.preflightHeaders.push({ ...request.headers });
    writeCorsHeaders(response, allowedOrigin);
    response.writeHead(204).end();
    return;
  }
  if (request.method !== 'PUT') {
    response.writeHead(404).end();
    return;
  }

  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    observation.putContentTypes.push(request.headers['content-type'] ?? '');
    observation.putBodies.push(Buffer.concat(chunks));
    observation.putStatuses.push(putStatus);
    if (putStatus === 200) writeCorsHeaders(response, allowedOrigin);
    response.setHeader('ETag', '"e2e-upload"');
    response.writeHead(putStatus).end();
  });
}

async function startUploadServer(putStatus: 200 | 403): Promise<UploadServer> {
  let allowedOrigin: string | null = null;
  const observation: UploadObservation = {
    preflightHeaders: [],
    putContentTypes: [],
    putBodies: [],
    putStatuses: [],
  };
  const server: Server = createServer((request, response) => {
    handleUpload(request, response, observation, allowedOrigin, putStatus);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    observation,
    uploadUrl: `http://127.0.0.1:${address.port}/r2-upload`,
    allowOrigin(origin: string): void {
      allowedOrigin = origin;
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function mockUploadApis(page: Page, uploadUrl: string): Promise<() => Promise<number>> {
  const shortId = E2E_FIXTURES.readyShortId;
  const publicUrl = `https://cdn.test/movies/${shortId}.mp4`;
  await page.addInitScript(({ expectedShortId, expectedUploadUrl, expectedPublicUrl }) => {
    const browserFetch = window.fetch.bind(window);
    window.fetch = ((input, init) => {
      const requestUrl = input instanceof Request ? input.url : String(input);
      const path = new URL(requestUrl, window.location.href).pathname;
      if (path === '/api/me/') {
        return Promise.resolve(Response.json({ name: 'noricha' }));
      }
      if (path === '/api/uploads/presign/') {
        return Promise.resolve(Response.json({
          shortId: expectedShortId,
          uploadUrl: expectedUploadUrl,
          publicUrl: expectedPublicUrl,
        }));
      }
      if (path === '/api/uploads/commit/') {
        const key = 'e2e:upload-commit-calls';
        sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? '0') + 1));
        return Promise.resolve(Response.json({
          shortId: expectedShortId,
          publicUrl: expectedPublicUrl,
          sizeBytes: 1024,
          expiresAt: null,
        }));
      }
      if (path === '/api/uploads/abandon/') {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return browserFetch(input, init);
    }) as typeof window.fetch;
  }, { expectedShortId: shortId, expectedUploadUrl: uploadUrl, expectedPublicUrl: publicUrl });
  return () => page.evaluate(() => Number(sessionStorage.getItem('e2e:upload-commit-calls') ?? '0'));
}

function expectPutPreflight(
  observation: UploadObservation,
  origin: string
): void {
  expect(observation.preflightHeaders).toHaveLength(1);
  const headers = observation.preflightHeaders[0];
  expect(headers?.origin).toBe(origin);
  expect(headers?.['access-control-request-method']?.toString().toLowerCase()).toBe('put');
  expect(headers?.['access-control-request-headers']?.toString().toLowerCase()).toContain(
    'content-type'
  );
}

test.describe('別 origin upload 応答の UI 契約', () => {
  test('ACAO なしの 403 はブラウザの CORS 失敗として扱われ、画面に失敗表示を出す', async ({ page }) => {
    test.setTimeout(180_000);
    const upload = await startUploadServer(403);
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    try {
      const commitCalls = await mockUploadApis(page, upload.uploadUrl);
      await page.goto('/ja/');
      const appOrigin = new URL(page.url()).origin;
      upload.allowOrigin(appOrigin);
      await page.locator('[data-convert-panel] [data-file-input]').setInputFiles({
        name: 'first.png',
        mimeType: 'image/png',
        buffer: ONE_PIXEL_PNG,
      });

      await expect(page.locator('[data-convert-panel] [data-file-error]')).toBeVisible();
      expectPutPreflight(upload.observation, appOrigin);
      expect(upload.observation.putStatuses).toEqual([403]);
      expect(upload.observation.putContentTypes).toEqual(['video/mp4']);
      expect(upload.observation.putBodies[0]?.subarray(4, 8).toString('ascii')).toBe('ftyp');
      expect(await commitCalls()).toBe(0);
      expect(
        consoleErrors.some(
          (message) => message.includes('conversion failed') && message.includes('TypeError')
        )
      ).toBe(true);
    } finally {
      await upload.close();
    }
  });

  test('ACAO ありの 200 なら複数画像を PUT・commit しプレビューへ進む', async ({ page }) => {
    test.setTimeout(180_000);
    const upload = await startUploadServer(200);

    try {
      const commitCalls = await mockUploadApis(page, upload.uploadUrl);
      await page.goto('/ja/');
      const appOrigin = new URL(page.url()).origin;
      upload.allowOrigin(appOrigin);
      await page.locator('[data-convert-panel] [data-file-input]').setInputFiles([
        { name: 'first.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG },
        { name: 'second.png', mimeType: 'image/png', buffer: ONE_PIXEL_PNG },
      ]);

      await expect(page).toHaveURL(new RegExp(`/${E2E_FIXTURES.readyShortId}/$`), {
        timeout: 120_000,
      });
      await expect(page.locator('[data-preview]')).toBeVisible();
      expectPutPreflight(upload.observation, appOrigin);
      expect(upload.observation.putStatuses).toEqual([200]);
      expect(upload.observation.putContentTypes).toEqual(['video/mp4']);
      expect(upload.observation.putBodies).toHaveLength(1);
      expect(upload.observation.putBodies[0]?.subarray(4, 8).toString('ascii')).toBe('ftyp');
      expect(await commitCalls()).toBe(1);
    } finally {
      await upload.close();
    }
  });
});
