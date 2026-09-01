import { afterEach, describe, expect, it } from 'bun:test';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const relay = new URL('../../streaming/relay.sh', import.meta.url).pathname;
const audioProfile = new URL('../../streaming/audio-profile.sh', import.meta.url).pathname;
const temporaryDirectories: string[] = [];
const READY_TIMEOUT_MS = 1_000;
const READY_POLL_INTERVAL_MS = 10;

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

function expectArgumentPair(argumentsList: string[], flag: string, value: string): void {
  const flagIndex = argumentsList.indexOf(flag);
  expect(flagIndex).toBeGreaterThanOrEqual(0);
  expect(argumentsList[flagIndex + 1]).toBe(value);
}

async function waitForMarker(marker: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await access(marker);
      return;
    } catch {
      await Bun.sleep(READY_POLL_INTERVAL_MS);
    }
  }
  throw new Error(`Timed out waiting for ${marker}`);
}

describe('MediaMTX relay hook', () => {
  it('MP3 profileをsourceし、外部からのprofile上書きを拒否する', async () => {
    const profile = Bun.spawn(['/bin/sh', '-c', `. "${audioProfile}"; printf '%s/%s/%s/%s/%s' "$RELAY_AUDIO_ENCODER" "$EXPECTED_AUDIO_CODEC" "$AUDIO_SAMPLE_RATE" "$AUDIO_CHANNELS" "$AUDIO_BITRATE"`], {
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await new Response(profile.stdout).text()).toBe('libmp3lame/mp3/48000/2/128k');
    expect(await profile.exited).toBe(0);

    const override = Bun.spawn(['/bin/sh', '-c', `. "${audioProfile}"`], {
      env: { ...process.env, RELAY_AUDIO_ENCODER: 'aac' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await override.exited).toBe(64);
  });

  it('12文字base62以外のMTX_PATHをffmpeg起動前に拒否する', async () => {
    const child = Bun.spawn([relay], {
      env: { ...process.env, MTX_PATH: 'live/../../etc', FFMPEG_BIN: '/bin/false' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(64);
  });

  it('optional audioをMP3 profileで変換し、安全なIDだけをingressからegressへrelayする', async () => {
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
    const argumentsList = (await readFile(fake.output, 'utf8')).trimEnd().split('\n');
    expect(argumentsList).toContain('0:a?');
    expectArgumentPair(argumentsList, '-c:v', 'copy');
    expectArgumentPair(argumentsList, '-c:a', 'libmp3lame');
    expectArgumentPair(argumentsList, '-ar', '48000');
    expectArgumentPair(argumentsList, '-ac', '2');
    expectArgumentPair(argumentsList, '-b:a', '128k');
    expect(argumentsList).toContain('rtsp://127.0.0.1:8554/live/AbCdEf123456');
    expect(argumentsList).toContain('rtsp://127.0.0.1:554/live/AbCdEf123456');
  });

  it('SIGTERM後はffmpeg childへ転送して親を正常終了する', async () => {
    const fake = await fakeFfmpeg('trap \'printf "%s" terminated > "$TERM_MARKER"; exit 0\' TERM\nprintf "%s" ready > "$READY_MARKER"\nwhile :; do sleep 1; done');
    const marker = join(dirname(fake.binary), 'term-marker');
    const readyMarker = join(dirname(fake.binary), 'ready-marker');
    const child = Bun.spawn([relay], {
      env: {
        ...process.env,
        MTX_PATH: 'live/AbCdEf123456',
        FFMPEG_BIN: fake.binary,
        TERM_MARKER: marker,
        READY_MARKER: readyMarker,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    await waitForMarker(readyMarker);
    expect(await readFile(readyMarker, 'utf8')).toBe('ready');
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    expect(await readFile(marker, 'utf8')).toBe('terminated');
  });
});
