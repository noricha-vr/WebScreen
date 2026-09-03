import { afterEach, describe, expect, it } from 'bun:test';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const replicaPull = new URL('../../streaming/replica-pull.sh', import.meta.url).pathname;
const temporaryDirectories: string[] = [];
const READY_TIMEOUT_MS = 2_000;
const READY_POLL_INTERVAL_MS = 10;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

interface FakeFfmpeg {
  binary: string;
  argsLog: string;
  callCountFile: string;
}

async function fakeFfmpeg(bodyScript: string): Promise<FakeFfmpeg> {
  const directory = await mkdtemp(join(tmpdir(), 'webscreen-replica-'));
  temporaryDirectories.push(directory);
  const binary = join(directory, 'ffmpeg');
  const argsLog = join(directory, 'args.log');
  const callCountFile = join(directory, 'call-count');
  await writeFile(
    binary,
    `#!/usr/bin/env bash
set -u
ARGS_LOG="${argsLog}"
CALL_COUNT_FILE="${callCountFile}"
call_num=0
if [[ -s "$CALL_COUNT_FILE" ]]; then
  call_num=$(cat "$CALL_COUNT_FILE")
fi
call_num=$((call_num + 1))
echo "$call_num" > "$CALL_COUNT_FILE"
{
  printf '===call%s===\\n' "$call_num"
  for arg in "$@"; do
    printf '%s\\n' "$arg"
  done
} >> "$ARGS_LOG"
${bodyScript}
`,
    'utf8',
  );
  await chmod(binary, 0o755);
  return { binary, argsLog, callCountFile };
}

async function readCallCount(fake: FakeFfmpeg): Promise<number> {
  try {
    const raw = await readFile(fake.callCountFile, 'utf8');
    return Number.parseInt(raw.trim(), 10);
  } catch {
    return 0;
  }
}

async function readArgs(fake: FakeFfmpeg): Promise<string> {
  try {
    return await readFile(fake.argsLog, 'utf8');
  } catch {
    return '';
  }
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

describe('MediaMTX replica-pull hook', () => {
  it('MTX_PATHが12文字base62でなければffmpeg起動前に拒否する', async () => {
    const child = Bun.spawn([replicaPull], {
      env: {
        ...process.env,
        MTX_PATH: 'live/../../etc',
        ORIGINS: 'origin-a.example',
        FFMPEG_BIN: '/bin/false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(64);
  });

  it('ORIGINSが空ならffmpeg起動前に拒否する', async () => {
    const child = Bun.spawn([replicaPull], {
      env: {
        ...process.env,
        MTX_PATH: 'live/AbCdEf123456',
        ORIGINS: '',
        FFMPEG_BIN: '/bin/false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(64);
  });

  it('SELF_HOSTSに一致するORIGINSは自己ループとして拒否する', async () => {
    const child = Bun.spawn([replicaPull], {
      env: {
        ...process.env,
        MTX_PATH: 'live/AbCdEf123456',
        ORIGINS: 'replica-1.example,other.example',
        SELF_HOSTS: 'replica-1.example',
        FFMPEG_BIN: '/bin/false',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(64);
  });

  it('1つ目のoriginで接続失敗したら2つ目のorigin URLでffmpegを起動する', async () => {
    // 1st call: exit 1 quickly to simulate connection failure.
    // 2nd call: exit 0 to simulate MediaMTX closing the pull cleanly.
    const fake = await fakeFfmpeg(
      `if [[ "$call_num" == "1" ]]; then exit 1; fi\nexit 0`,
    );
    const child = Bun.spawn([replicaPull], {
      env: {
        ...process.env,
        MTX_PATH: 'live/AbCdEf123456',
        ORIGINS: 'origin-a.example,origin-b.example:5540',
        FFMPEG_BIN: fake.binary,
        REPLICA_MAX_RETRIES: '0',
        REPLICA_BASE_BACKOFF_SECONDS: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await child.exited).toBe(0);
    expect(await readCallCount(fake)).toBe(2);
    const argsBlob = await readArgs(fake);
    // 1st call targets origin-a (default port 554), 2nd call targets origin-b:5540 (explicit port kept).
    expect(argsBlob).toContain('rtsp://origin-a.example:554/live/AbCdEf123456');
    expect(argsBlob).toContain('rtsp://origin-b.example:5540/live/AbCdEf123456');
    // The re-publish target is the local egress at the default RTSP port.
    expect(argsBlob).toContain('rtsp://127.0.0.1:554/live/AbCdEf123456');
    // -c copy semantics are preserved (no re-encode).
    expect(argsBlob).toContain('-c');
    expect(argsBlob).toContain('copy');
  });

  it('全originが失敗したら非0で終了する', async () => {
    const fake = await fakeFfmpeg('exit 1');
    const child = Bun.spawn([replicaPull], {
      env: {
        ...process.env,
        MTX_PATH: 'live/AbCdEf123456',
        ORIGINS: 'dead-a.example,dead-b.example',
        FFMPEG_BIN: fake.binary,
        REPLICA_MAX_RETRIES: '0',
        REPLICA_BASE_BACKOFF_SECONDS: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await child.exited;
    expect(exitCode).not.toBe(0);
    // Both origins were attempted once.
    expect(await readCallCount(fake)).toBe(2);
  });

  it('SIGTERMで子ffmpegを止めて親を0で終了する', async () => {
    const fake = await fakeFfmpeg(`
trap 'printf "%s" terminated > "$TERM_MARKER"; exit 0' TERM
printf "%s" ready > "$READY_MARKER"
while :; do sleep 1; done
`);
    const marker = join(dirname(fake.binary), 'term-marker');
    const readyMarker = join(dirname(fake.binary), 'ready-marker');
    const child = Bun.spawn([replicaPull], {
      env: {
        ...process.env,
        MTX_PATH: 'live/AbCdEf123456',
        ORIGINS: 'origin-a.example',
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
