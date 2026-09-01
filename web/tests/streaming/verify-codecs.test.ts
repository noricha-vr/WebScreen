import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const verifyCodecs = new URL('../../streaming/verify-codecs.sh', import.meta.url).pathname;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fakeFfprobe(): Promise<{ binary: string; output: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'webscreen-codec-probe-'));
  temporaryDirectories.push(directory);
  const binary = join(directory, 'ffprobe');
  const output = join(directory, 'arguments');
  await writeFile(
    binary,
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$PROBE_ARGS_FILE"\nprintf "%b" "$PROBE_ROWS"\n',
    'utf8'
  );
  await chmod(binary, 0o755);
  return { binary, output };
}

describe('codec deploy smoke', () => {
  it('rtsptをffprobe用rtspへ変換し、H264とAACを一度のprobeで確認する', async () => {
    const fake = await fakeFfprobe();
    const child = Bun.spawn([verifyCodecs, 'rtspt://media.example/live/AbCdEf123456'], {
      env: {
        ...process.env,
        FFPROBE_BIN: fake.binary,
        PROBE_ARGS_FILE: fake.output,
        PROBE_ROWS: 'h264,video\naac,audio\n',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(0);
    const argumentsText = await readFile(fake.output, 'utf8');
    expect(argumentsText).toContain('%+1');
    expect(argumentsText).toContain('rtsp://media.example/live/AbCdEf123456');
    expect(argumentsText).not.toContain('rtspt://');
  });

  it('video-only段階は音声なしを受理し、通常段階では拒否する', async () => {
    const fake = await fakeFfprobe();
    const environment = {
      ...process.env,
      FFPROBE_BIN: fake.binary,
      PROBE_ARGS_FILE: fake.output,
      PROBE_ROWS: 'h264,video\n',
    };
    const shadow = Bun.spawn([verifyCodecs, 'rtsp://media.example/live/AbCdEf123456', '--video-only'], {
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await shadow.exited).toBe(0);

    const audioRequired = Bun.spawn([verifyCodecs, 'rtsp://media.example/live/AbCdEf123456'], {
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await audioRequired.exited).toBe(1);
  });
});
