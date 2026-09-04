import { requirePipe } from './latency-probe-observe';

/** 通知コマンドを注入する環境変数。個人環境のスクリプトをリポジトリに固定パスで書かないための唯一の入口。 */
export const NOTIFY_COMMAND_ENV = 'WEBSCREEN_LATENCY_NOTIFY_COMMAND';

/** Discord のチャンネル ID の書式。CLI と run 境界の双方が同じ規則で弾けるよう正本をここに 1 つだけ置く。 */
export const NOTIFY_CHANNEL_ID_PATTERN = /^\d{15,25}$/;

/** 通知は計測の付帯処理なので、固まっても run を止めずに打ち切る。 */
const NOTIFY_TIMEOUT_MS = 10_000;

/** タイムアウト後、SIGTERM を無視する子を待つ猶予。過ぎたら SIGKILL へ上げる（30 秒の孤児を残さない）。 */
const NOTIFY_KILL_GRACE_MS = 500;

/** kill 後に stderr の EOF を待つ猶予。孫プロセスが fd を握ったままだと閉じないので無期限には待たない。 */
const NOTIFY_STDERR_GRACE_MS = 500;

/** stderr は警告に載せる診断用なので上限で切る（暴走した子の出力でメモリを食わない）。 */
const NOTIFY_STDERR_LIMIT_BYTES = 4_096;

/** 上限で切ったことを警告文から判別できるようにする印。 */
export const NOTIFY_STDERR_TRUNCATED_SUFFIX = '…（stderr 切り捨て）';

/** タイムアウトで打ち切った時に警告へ出す擬似 exit（実際の終了コードと区別する）。 */
const NOTIFY_TIMEOUT_EXIT = -1;

/** 期限切れを実際の終了コード・stderr 文字列と取り違えないための番兵。 */
const NOTIFY_DEADLINE = Symbol('notify deadline');

/** 起動した通知コマンドのうち、この module が使う最小の面だけを型にする（Bun.spawn の overload に縛られずテストで差し替えるため）。 */
export interface NotifyChild {
  readonly exited: Promise<number>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal?: NodeJS.Signals | number): void;
}

/** argv と stdin（JSON 1 行）を受け取ってプロセスを起こす関数。既定は Bun.spawn。 */
export type NotifySpawn = (argv: readonly string[], stdin: Uint8Array) => NotifyChild;

/**
 * シェルを介さず argv へ分解する簡易パーサ。
 * 空白区切りで、`'…'` / `"…"` に囲めば空白を含む引数を書ける。引用符は語の途中でも開閉でき（`--m='a b'` → `--m=a b`）、
 * エスケープ・変数展開・`~` 展開・glob は解釈しない（`~` を使うと literal のパスになり必ず失敗する。docs の例は `$HOME` を shell 側で展開させる）。
 */
export function parseCommandLine(raw: string): string[] {
  const argv: string[] = [];
  let current: string | null = null;
  let quote: '"' | "'" | null = null;
  for (const char of raw) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current = (current ?? '') + char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current = current ?? '';
      continue;
    }
    if (/\s/.test(char)) {
      if (current !== null) argv.push(current);
      current = null;
      continue;
    }
    current = (current ?? '') + char;
  }
  if (quote !== null) throw new Error(`${NOTIFY_COMMAND_ENV} の引用符が閉じていません`);
  if (current !== null) argv.push(current);
  return argv;
}

/**
 * 環境変数の値を argv テンプレートへ変換する。未設定・空白のみなら null（通知を諦めて計測は続行する）。
 * 不正な値は run の副作用が始まる前に投げたいので、呼び出しは配信開始前に置く。
 */
export function notifyCommandTemplate(raw: string | undefined): string[] | null {
  if (raw === undefined || raw.trim() === '') return null;
  const argv = parseCommandLine(raw);
  if (argv.length === 0 || argv[0] === '') throw new Error(`${NOTIFY_COMMAND_ENV} にコマンド名がありません`);
  return argv;
}

/** 通知先チャンネル ID を CLI と run 境界で同じ規則で検証する。 */
export function validateNotifyChannelId(channelId: string): void {
  if (!NOTIFY_CHANNEL_ID_PATTERN.test(channelId)) throw new Error('--notify-discord must be a Discord channel id');
}

/** 通知コマンドが未設定であることを、Chrome 起動・配信開始より前に知らせる（計測はそのまま続行する）。 */
export function warnNotifyCommandMissing(): void {
  console.warn(`通知コマンド未設定のため通知をスキップします（${NOTIFY_COMMAND_ENV} を設定すると配信 URL を投稿できます）`);
}

/** テンプレートの各引数の `{url}` / `{channel}` を実値へ置換する（シェルを通さないのでクォートは不要）。 */
export function buildNotifyArgv(template: readonly string[], values: { url: string; channel: string }): string[] {
  return template.map((argument) => argument.replaceAll('{url}', values.url).replaceAll('{channel}', values.channel));
}

/** コマンドが引数ではなく stdin から読みたい場合のための JSON 1 行。 */
export function notifyStdinJson(values: { url: string; channel: string }): string {
  return `${JSON.stringify({ url: values.url, channel: values.channel })}\n`;
}

const spawnNotifyCommand: NotifySpawn = (argv, stdin) => {
  // stdout は使わないので捨てる（読まれない pipe が満杯になると子が write でブロックし、成功なのにタイムアウト扱いになる）
  const child = Bun.spawn([...argv], { stdin, stdout: 'ignore', stderr: 'pipe' });
  return { exited: child.exited, stderr: requirePipe(child.stderr, 'notify stderr'), kill: (signal) => child.kill(signal) };
};

function describeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }

/** promise と期限を競わせる。期限側は Symbol で返し、終了コード 0 や空文字と区別できるようにする。 */
async function raceDeadline<T>(promise: Promise<T>, milliseconds: number): Promise<T | typeof NOTIFY_DEADLINE> {
  return Promise.race([promise, Bun.sleep(milliseconds).then((): typeof NOTIFY_DEADLINE => NOTIFY_DEADLINE)]);
}

/**
 * stderr を上限付きで読む。上限を超えた分は捨てながら EOF まで drain する
 * （途中で cancel すると、まだ生きている子が stderr への write で EPIPE を受けて成功が失敗に化ける）。
 */
async function readStderrCapped(stream: ReadableStream<Uint8Array>, limitBytes = NOTIFY_STDERR_LIMIT_BYTES): Promise<string> {
  const reader = stream.getReader();
  const kept: Uint8Array[] = [];
  let keptBytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined || value.length === 0) continue;
    const room = limitBytes - keptBytes;
    if (room <= 0) { truncated = true; continue; }
    kept.push(value.length > room ? value.subarray(0, room) : value);
    keptBytes += Math.min(value.length, room);
    if (value.length > room) truncated = true;
  }
  const joined = new Uint8Array(keptBytes);
  let offset = 0;
  for (const chunk of kept) { joined.set(chunk, offset); offset += chunk.length; }
  // 上限で切ると多バイト文字が割れるが、診断用途なので U+FFFD のまま出す
  const text = new TextDecoder().decode(joined);
  return truncated ? `${text}${NOTIFY_STDERR_TRUNCATED_SUFFIX}` : text;
}

/** 期限を過ぎた子を SIGTERM → 猶予 → SIGKILL の順で落とす（SIGTERM を無視する子を孤児として残さない）。 */
async function terminateNotifyChild(child: NotifyChild): Promise<void> {
  child.kill();
  if (await raceDeadline(child.exited, NOTIFY_KILL_GRACE_MS) === NOTIFY_DEADLINE) child.kill('SIGKILL');
}

/**
 * VRChat を動かす別 PC で URL を拾えるよう、注入されたコマンドへ配信 URL を渡す。
 * 起動失敗・異常終了・タイムアウトはすべて警告のみで、計測は止めない。
 * stderr は await せずに読み始め（子が固まると pipe が閉じず、先に await するとタイムアウトが始まらない）、
 * 回収にも期限を付けて関数全体が timeoutMs + 猶予 で必ず返るようにする。
 */
export async function notifyStreamUrl(options: {
  template: readonly string[];
  url: string;
  channel: string;
  timeoutMs?: number;
  spawn?: NotifySpawn;
}): Promise<void> {
  const { template, url, channel, timeoutMs = NOTIFY_TIMEOUT_MS, spawn = spawnNotifyCommand } = options;
  const argv = buildNotifyArgv(template, { url, channel });
  let child: NotifyChild;
  try {
    child = spawn(argv, new TextEncoder().encode(notifyStdinJson({ url, channel })));
  } catch (error) {
    // 実行ファイルが無い等、spawn が同期で投げるケース。通知の失敗で run を落とさない
    console.warn(`配信 URL の通知コマンドを起動できませんでした（${argv[0] ?? ''}）: ${describeError(error)}`);
    return;
  }
  const stderr = readStderrCapped(child.stderr).catch(describeError);
  // 期限判定は最初の race だけで決める（kill 後に exited が 137 等を返しても「タイムアウト」の事実は変わらない）
  const exit = await raceDeadline(child.exited, timeoutMs);
  if (exit === NOTIFY_DEADLINE) await terminateNotifyChild(child);
  const collected = await raceDeadline(stderr, NOTIFY_STDERR_GRACE_MS);
  const diagnostics = (collected === NOTIFY_DEADLINE ? '(stderr を回収できませんでした)' : collected).trim();
  if (exit === NOTIFY_DEADLINE) console.warn(`配信 URL の通知がタイムアウトしました（exit ${NOTIFY_TIMEOUT_EXIT}、${timeoutMs} ms）: ${diagnostics}`);
  else if (exit !== 0) console.warn(`配信 URL の通知に失敗しました（exit ${exit}）: ${diagnostics}`);
  else console.info(`配信 URL を通知しました（channel ${channel}）`);
}
