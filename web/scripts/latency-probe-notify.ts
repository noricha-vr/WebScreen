import { readPipeText, requirePipe } from './latency-probe-observe';

/** 通知コマンドを注入する環境変数。個人環境のスクリプトをリポジトリに固定パスで書かないための唯一の入口。 */
export const NOTIFY_COMMAND_ENV = 'WEBSCREEN_LATENCY_NOTIFY_COMMAND';

/** 通知は計測の付帯処理なので、固まっても run を止めずに打ち切る。 */
const NOTIFY_TIMEOUT_MS = 10_000;

/** 起動した通知コマンドのうち、この module が使う最小の面だけを型にする（Bun.spawn の overload に縛られずテストで差し替えるため）。 */
export interface NotifyChild {
  readonly exited: Promise<number>;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(): void;
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
  return { exited: child.exited, stderr: requirePipe(child.stderr, 'notify stderr'), kill: () => child.kill() };
};

/**
 * VRChat を動かす別 PC で URL を拾えるよう、注入されたコマンドへ配信 URL を渡す（失敗は計測を止めない）。
 * stderr は await せずに読み始める（子が固まると pipe が閉じず、先に await するとタイムアウトが始まらない）。
 */
export async function notifyStreamUrl(options: {
  template: readonly string[] | null;
  url: string;
  channel: string;
  timeoutMs?: number;
  spawn?: NotifySpawn;
}): Promise<void> {
  const { template, url, channel, timeoutMs = NOTIFY_TIMEOUT_MS, spawn = spawnNotifyCommand } = options;
  if (template === null) {
    console.warn(`通知コマンド未設定のため通知をスキップします（${NOTIFY_COMMAND_ENV} を設定すると配信 URL を投稿できます）`);
    return;
  }
  const argv = buildNotifyArgv(template, { url, channel });
  const child = spawn(argv, new TextEncoder().encode(notifyStdinJson({ url, channel })));
  const stderr = readPipeText(child.stderr).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  const exit = await Promise.race([child.exited, Bun.sleep(timeoutMs).then(() => { child.kill(); return -1; })]);
  const diagnostics = (await stderr).trim();
  if (exit !== 0) console.warn(`配信 URL の通知に失敗またはタイムアウトしました（exit ${exit}）: ${diagnostics}`);
  else console.info(`配信 URL を通知しました（channel ${channel}）`);
}
