import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';

const replicaEgress = new URL('../../streaming/mediamtx-egress-replica.yml', import.meta.url).pathname;

const readReplicaConfig = () => readFile(replicaEgress, 'utf8');

describe('read replica pull configuration', () => {
  it('pulls through a regexp capture group so `source` can expand $G1', async () => {
    const contents = await readReplicaConfig();
    expect(contents).toMatch(/^ {2}"~\^live\/\(\[A-Za-z0-9\]\{12\}\)\$":$/m);
    // 取り寄せ先は origin だけに解決するホスト固定（webscreen.tv は全 read ノードに解決し自己参照しうる）
    expect(contents).toMatch(/^ {4}source: rtsp:\/\/stream\.web-screen\.net:554\/live\/\$G1$/m);
  });

  it('starts the pull on demand', async () => {
    const contents = await readReplicaConfig();
    expect(contents).toMatch(/^ {4}sourceOnDemand: true$/m);
    expect(contents).toMatch(/^ {4}sourceOnDemandStartTimeout: 10s$/m);
    expect(contents).toMatch(/^ {4}sourceOnDemandCloseAfter: 10s$/m);
  });

  it('does not fall back to the ffmpeg runOnDemand hook', async () => {
    // ffmpeg adds one source frame interval per hop (verification.md I27), so the native
    // MediaMTX source must stay the only pull path.
    const contents = await readReplicaConfig();
    expect(contents).not.toContain('runOnDemand');
  });

  it('keeps the API on loopback and grants no publish permission', async () => {
    // 公開 :554 の read だけを許し、publish は誰にも与えない（source が唯一の供給元）。API は Caddy 経由のみ。
    const contents = await readReplicaConfig();
    expect(contents).toMatch(/^apiAddress: 127\.0\.0\.1:9998$/m);
    expect(contents).not.toMatch(/action: publish/);
    expect(contents).toMatch(/^ {6}- action: read\n {8}path: "~\^live\/\[A-Za-z0-9\]\{12\}\$"$/m);
  });

  it('pulls over RTSP TCP', async () => {
    const contents = await readReplicaConfig();
    expect(contents).toMatch(/^ {4}rtspTransport: tcp$/m);
  });
});
