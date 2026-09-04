import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';

const originEgress = new URL('../../streaming/mediamtx-egress.yml', import.meta.url).pathname;
const replicaEgress = new URL('../../streaming/mediamtx-egress-replica.yml', import.meta.url).pathname;
const nftablesEgress = new URL('../../streaming/nftables-egress.nft', import.meta.url).pathname;

describe('egress connection caps', () => {
  it('origin and replica cap every live path at 60 readers', async () => {
    for (const config of [originEgress, replicaEgress]) {
      const contents = await readFile(config, 'utf8');
      expect(contents).toMatch(/^\s{2}maxReaders: 60$/m);
    }
  });

  it('uses a global, fail-open TCP 554 connection cap', async () => {
    const contents = await readFile(nftablesEgress, 'utf8');
    expect(contents).toContain('ct count over 505');
    expect(contents).toContain('policy accept');
    expect(contents).not.toContain('meter');
    expect(contents).not.toContain('flush ruleset');
  });
});
