import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const relay = new URL('../../streaming/relay.sh', import.meta.url).pathname;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fakeFfmpeg(contents: string): Promise<{ binary: string; output: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'webscreen-relay-'));
  temporaryDirectories.push(directory);
  const binary = join(directory, 'ffmpeg');
  const output = join(directory, 'arguments');
  await writeFile(binary, `#!/usr/bin/env bash\n${contents}\n`, 'utf8');
  await chmod(binary, 0o755);
  return { binary, output };
}

describe('MediaMTX relay hook', () => {
  it('12文字base62以外のMTX_PATHをffmpeg起動前に拒否する', async () => {
    const child = Bun.spawn([relay], {
      env: { ...process.env, MTX_PATH: 'live/../../etc', FFMPEG_BIN: '/bin/false' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(64);
  });

  it('optional audio map付きで安全なIDだけをingressからegressへrelayする', async () => {
    const fake = await fakeFfmpeg('printf "%s\\n" "$@" > "$RELAY_ARGS_FILE"');
    const child = Bun.spawn([relay], {
      env: {
        ...process.env,
        MTX_PATH: 'live/AbCdEf123456',
        FFMPEG_BIN: fake.binary,
        RELAY_ARGS_FILE: fake.output,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(0);
    const argumentsText = await readFile(fake.output, 'utf8');
    expect(argumentsText).toContain('0:a?');
    expect(argumentsText).toContain('rtsp://127.0.0.1:8554/live/AbCdEf123456');
    expect(argumentsText).toContain('rtsp://127.0.0.1:554/live/AbCdEf123456');
  });

  it('SIGTERM後はffmpeg childへ転送して親を正常終了する', async () => {
    const fake = await fakeFfmpeg('exec sleep 30');
    const child = Bun.spawn([relay], {
      env: { ...process.env, MTX_PATH: 'live/AbCdEf123456', FFMPEG_BIN: fake.binary },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await Bun.sleep(50);
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
  });
});
