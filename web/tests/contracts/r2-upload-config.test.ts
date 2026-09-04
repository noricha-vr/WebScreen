import { describe, expect, test } from 'bun:test';

interface CorsRule {
  allowed: {
    origins: string[];
    methods: string[];
    headers: string[];
  };
}

interface CorsConfig {
  rules: CorsRule[];
}

async function corsConfig(): Promise<CorsConfig> {
  return Bun.file(new URL('../../r2-cors.json', import.meta.url)).json() as Promise<CorsConfig>;
}

describe('R2 browser upload contract', () => {
  test('本番 origin から video/mp4 を PUT できる CORS 設定を保持する', async () => {
    const config = await corsConfig();
    const productionRule = config.rules.find((rule) =>
      rule.allowed.origins.includes('https://web-screen.net')
    );

    expect(productionRule).toBeDefined();
    expect(productionRule?.allowed.methods).toContain('PUT');
    expect(productionRule?.allowed.headers.map((header) => header.toLowerCase())).toContain(
      'content-type'
    );
  });

  test('本番 upload origin を wildcard に広げない', async () => {
    const config = await corsConfig();

    expect(config.rules.flatMap((rule) => rule.allowed.origins)).not.toContain('*');
  });
});
