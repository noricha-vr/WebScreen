import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
    '#!/usr/bin/env bash\nprintf "%s\\n" "$@" >> "$PROBE_ARGS_FILE"\nprintf "%s\\n" "---" >> "$PROBE_ARGS_FILE"\nattempt=1\nif [[ -n "${PROBE_ATTEMPT_FILE:-}" ]]; then\n  if [[ -f "$PROBE_ATTEMPT_FILE" ]]; then\n    read -r attempt < "$PROBE_ATTEMPT_FILE"\n    attempt=$((attempt + 1))\n  fi\n  printf "%s" "$attempt" > "$PROBE_ATTEMPT_FILE"\nfi\nif (( attempt <= ${PROBE_FAIL_UNTIL:-0} )); then exit 1; fi\nprintf "%b" "$PROBE_ROWS"\n',
    'utf8'
  );
  await chmod(binary, 0o755);
  return { binary, output };
}

async function readProbeAttempts(output: string): Promise<string[][]> {
  const records = (await readFile(output, 'utf8')).trimEnd().split('\n---\n');
  return records.map((record) => record.split('\n'));
}

function expectTimeoutArgument(argumentsList: string[]): void {
  const timeoutIndex = argumentsList.indexOf('-timeout');
  expect(timeoutIndex).toBeGreaterThanOrEqual(0);
  expect(argumentsList[timeoutIndex + 1]).toBe('5000000');
}

describe('codec deploy smoke', () => {
  it('rtsptをffprobe用rtspへ変換し、H264とMP3 profileを一度のprobeで確認する', async () => {
    const fake = await fakeFfprobe();
    const child = Bun.spawn([verifyCodecs, 'rtspt://media.example/live/AbCdEf123456'], {
      env: {
        ...process.env,
        FFPROBE_BIN: fake.binary,
        PROBE_ARGS_FILE: fake.output,
        PROBE_ROWS: 'h264,video\nmp3,audio,48000,2\n',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(0);
    const [argumentsList] = await readProbeAttempts(fake.output);
    expect(argumentsList).toContain('%+1');
    expect(argumentsList).toContain('stream=codec_type,codec_name,sample_rate,channels');
    expectTimeoutArgument(argumentsList);
    expect(argumentsList).toContain('rtsp://media.example/live/AbCdEf123456');
    expect(argumentsList).not.toContain('rtspt://');
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

  it('AAC、異なるsample rate、または異なるchannelsを通常段階で拒否する', async () => {
    const cases = [
      'h264,video\naac,audio,48000,2\n',
      'h264,video\nmp3,audio,44100,2\n',
      'h264,video\nmp3,audio,48000,1\n',
    ];

    for (const rows of cases) {
      const fake = await fakeFfprobe();
      const child = Bun.spawn([verifyCodecs, 'rtsp://media.example/live/AbCdEf123456'], {
        env: {
          ...process.env,
          FFPROBE_BIN: fake.binary,
          PROBE_ARGS_FILE: fake.output,
          PROBE_ROWS: rows,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await child.exited).toBe(1);
    }
  });

  it('invalid pathをprobe前に拒否する', async () => {
    const child = Bun.spawn([verifyCodecs, 'rtspt://media.example/live/../../etc'], {
      env: { ...process.env, FFPROBE_BIN: '/bin/false' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(64);
  });

  it('ffprobe失敗時は同じtimeout付きprobeを再試行する', async () => {
    const fake = await fakeFfprobe();
    const attempts = join(dirname(fake.binary), 'attempts');
    const child = Bun.spawn([verifyCodecs, 'rtsp://media.example/live/AbCdEf123456'], {
      env: {
        ...process.env,
        FFPROBE_BIN: fake.binary,
        PROBE_ARGS_FILE: fake.output,
        PROBE_ATTEMPT_FILE: attempts,
        PROBE_FAIL_UNTIL: '1',
        PROBE_ROWS: 'h264,video\nmp3,audio,48000,2\n',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(0);
    expect(await readFile(attempts, 'utf8')).toBe('2');
    const probeAttempts = await readProbeAttempts(fake.output);
    expect(probeAttempts).toHaveLength(2);
    probeAttempts.forEach(expectTimeoutArgument);
  });

  it('ffprobeが3回失敗した時はtimeout付きでfail closedにする', async () => {
    const fake = await fakeFfprobe();
    const attempts = join(dirname(fake.binary), 'attempts');
    const child = Bun.spawn([verifyCodecs, 'rtsp://media.example/live/AbCdEf123456'], {
      env: {
        ...process.env,
        FFPROBE_BIN: fake.binary,
        PROBE_ARGS_FILE: fake.output,
        PROBE_ATTEMPT_FILE: attempts,
        PROBE_FAIL_UNTIL: '3',
        PROBE_ROWS: 'h264,video\nmp3,audio,48000,2\n',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = new Response(child.stderr).text();
    expect(await child.exited).toBe(1);
    expect(await readFile(attempts, 'utf8')).toBe('3');
    expect(await stderr).toContain('ffprobe failed after 3 attempts');
    const probeAttempts = await readProbeAttempts(fake.output);
    expect(probeAttempts).toHaveLength(3);
    probeAttempts.forEach(expectTimeoutArgument);
  });
});
