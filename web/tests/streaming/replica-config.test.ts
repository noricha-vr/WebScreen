import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';

const replicaEgress = new URL('../../streaming/mediamtx-egress-replica.yml', import.meta.url).pathname;

const readReplicaConfig = () => readFile(replicaEgress, 'utf8');

describe('read replica pull configuration', () => {
  it('pulls through a regexp capture group so `source` can expand $G1', async () => {
    const contents = await readReplicaConfig();
    expect(contents).toMatch(/^ {2}"~\^live\/\(\[A-Za-z0-9\]\{12\}\)\$":$/m);
    expect(contents).toMatch(/^ {4}source: rtsp:\/\/\S+\/live\/\$G1$/m);
  });

  it('starts the pull on demand', async () => {
    const contents = await readReplicaConfig();
    expect(contents).toMatch(/^ {4}sourceOnDemand: true$/m);
  });

  it('does not fall back to the ffmpeg runOnDemand hook', async () => {
    // ffmpeg adds one source frame interval per hop (verification.md I27), so the native
    // MediaMTX source must stay the only pull path.
    const contents = await readReplicaConfig();
    expect(contents).not.toContain('runOnDemand');
  });

  it('pulls over RTSP TCP', async () => {
    const contents = await readReplicaConfig();
    expect(contents).toMatch(/^ {4}rtspTransport: tcp$/m);
  });
});
