/**
 * cron の死活監視（dead-man's switch）。
 *
 * 保持期間バッチは失敗しても「そもそも発火しなくなっても」誰も気づけなかった。
 * 成功のたびに D1 へ時刻と件数を残し、別の cron がその鮮度を見て通知する。
 * 「実行されたか」ではなく「結果が残ったか」で検証できる形にするのが目的。
 *
 * D1 も通知の送信もインターフェースで注入し、現在時刻は引数で受け取る
 * （Date.now を呼ぶのは cron の entry 層だけ）。判定は純関数に切り出してあるので、
 * workerd なしで全分岐をテストできる。
 */

import { postDiscordWebhook } from '../infra/discord-webhook';

/** D1 の最小操作面。この監視が必要とするのは all / run だけ。 */
export interface CronRunDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}

/** 保持期間バッチ本体の実行記録を持つ行。 */
export const RETENTION_RUN_NAME = 'retention';

/** 保持期間バッチの通知状態を持つ行（連投防止と回復通知に使う）。 */
export const RETENTION_ALERT_NAME = 'retention-alert';

/**
 * 最終成功からこれを超えたら停止とみなす。
 *
 * バッチは毎時 1 回なので「2 回連続で発火しなかった」= 2 時間空く。Cloudflare 側の
 * スケジュール遅延を 15 分見込んで足し、1 回落ちただけでは鳴らないようにしている
 * （毎時のジョブで閾値を 2 時間ちょうどにすると、遅延だけで誤報が出る）。
 */
export const CRON_STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000 + 15 * 60 * 1000;

/**
 * 同じ停止状態で再通知するまでの間隔。復旧できない障害でチャンネルを毎時
 * 埋めないための連投防止。回復通知はこの間隔に関係なく 1 回だけ出す。
 */
export const CRON_REALERT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** cron_runs の 1 行（列名は D1 のまま）。 */
interface CronRunRow {
  last_success_at: string;
  last_summary: string | null;
}

/** 通知側の行が持つ状態。 */
export type CronAlertState = 'alerting' | 'recovered';

/** 直近の通知（送った時刻とその時の状態）。 */
export interface CronAlertRecord {
  at: Date;
  state: CronAlertState;
}

/** 通知するかどうかの判定結果。 */
export type CronAlertDecision = 'none' | 'alert' | 'recovered';

/** /api/health/ がそのまま載せる鮮度。 */
export interface CronFreshness {
  /** 最後に成功した実行の基準時刻（ISO8601）。記録が無い・壊れていれば null。 */
  lastSuccessAt: string | null;
  ageSeconds: number | null;
  stale: boolean;
}

/** 通知の送信境界。送れたかどうかだけを返し、例外は出さない（通知の失敗で cron を落とさない）。 */
export type CronAlertNotifier = (message: string) => Promise<boolean>;

/**
 * 既定の通知先（Discord の webhook）。
 *
 * cron の entry 層は infra を直接叩けない（docs/architecture-contract.toml）ため、
 * 送信先の組み立てはここで行い、entry へは CronAlertNotifier だけを渡す。
 */
export function createDiscordNotifier(webhookUrl: string): CronAlertNotifier {
  return (message) => postDiscordWebhook(webhookUrl, message);
}

/**
 * D1 に混在しうる 2 つの時刻形式（ISO8601 と `YYYY-MM-DD HH:MM:SS`）を UTC として解く。
 * 後者をそのまま Date.parse に渡すと実行環境のローカル時刻として解釈され、UTC で動く
 * workerd と手元の bun test で結果がずれる。
 */
function parseUtc(value: string): number {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  return Date.parse(/[Z+]|-\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`);
}

/** cron_runs の 1 行を取る。行が無ければ null。 */
async function readRow(database: CronRunDatabase, name: string): Promise<CronRunRow | null> {
  const { results } = await database
    .prepare('SELECT last_success_at, last_summary FROM cron_runs WHERE name = ?')
    .bind(name)
    .all<CronRunRow>();
  return results[0] ?? null;
}

/**
 * ジョブの成功を記録する。同じ name の行を上書きするので履歴は残らない
 * （履歴が要る用途は Cloudflare 側の実行ログが持つ。ここは「最後に成功したのはいつか」だけ）。
 */
export async function recordCronRun(input: {
  database: CronRunDatabase;
  name: string;
  at: Date;
  summary: unknown;
}): Promise<void> {
  await input.database
    .prepare(
      `INSERT INTO cron_runs (name, last_success_at, last_summary) VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         last_success_at = excluded.last_success_at,
         last_summary = excluded.last_summary`
    )
    .bind(input.name, input.at.toISOString(), JSON.stringify(input.summary))
    .run();
}

/**
 * 記録されている時刻から鮮度を出す。
 *
 * 記録が無い（初回デプロイ直後・テーブルを作った直後）場合と、値が壊れている場合は
 * どちらも stale にする。「読めないので分からない」を正常扱いにすると、監視自体が
 * 静かに死ぬため。
 */
export function evaluateFreshness(now: Date, lastSuccessAt: string | null): CronFreshness {
  if (lastSuccessAt === null) return { lastSuccessAt: null, ageSeconds: null, stale: true };

  const parsed = parseUtc(lastSuccessAt);
  if (Number.isNaN(parsed)) return { lastSuccessAt: null, ageSeconds: null, stale: true };

  const ageMs = now.getTime() - parsed;
  return {
    lastSuccessAt: new Date(parsed).toISOString(),
    ageSeconds: Math.floor(ageMs / 1000),
    stale: ageMs > CRON_STALE_THRESHOLD_MS,
  };
}

/** /api/health/ 用に、保持期間バッチの鮮度を読む。 */
export async function readRetentionFreshness(
  database: CronRunDatabase,
  now: Date
): Promise<CronFreshness> {
  const row = await readRow(database, RETENTION_RUN_NAME);
  return evaluateFreshness(now, row?.last_success_at ?? null);
}

/**
 * 通知するかを決める（純関数）。
 *
 * - 停止中: 前回が通知済みで再通知の間隔内なら黙る。それ以外は通知する
 * - 正常時: 直前が停止通知だった時だけ「回復」を 1 回出す
 */
export function decideCronAlert(input: {
  now: Date;
  stale: boolean;
  lastAlert: CronAlertRecord | null;
}): CronAlertDecision {
  const { now, stale, lastAlert } = input;

  if (!stale) return lastAlert?.state === 'alerting' ? 'recovered' : 'none';

  if (lastAlert?.state === 'alerting') {
    const sinceLast = now.getTime() - lastAlert.at.getTime();
    return sinceLast < CRON_REALERT_INTERVAL_MS ? 'none' : 'alert';
  }
  return 'alert';
}

/** 通知側の行を CronAlertRecord に直す。読めない行は「通知していない」として扱う。 */
function parseAlertRecord(row: CronRunRow | null): CronAlertRecord | null {
  if (row === null) return null;

  const at = parseUtc(row.last_success_at);
  if (Number.isNaN(at)) return null;

  const state = row.last_summary === null ? null : readState(row.last_summary);
  if (state === null) return null;

  return { at: new Date(at), state };
}

function readState(summary: string): CronAlertState | null {
  try {
    const parsed: unknown = JSON.parse(summary);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const state = (parsed as { state?: unknown }).state;
    return state === 'alerting' || state === 'recovered' ? state : null;
  } catch {
    // 壊れた JSON は「状態不明」= 未通知として扱う（次の判定で改めて通知する）。
    return null;
  }
}

/** 経過時間を日本語 1 語にする（通知文面用）。 */
function formatAge(ageSeconds: number | null): string {
  if (ageSeconds === null) return '不明';

  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) return `${minutes} 分`;
  return `${Math.floor(minutes / 60)} 時間 ${minutes % 60} 分`;
}

/** 通知の本文。値そのものは載せず、いつ・どれだけ止まっているかだけを日本語で書く。 */
export function buildAlertMessage(input: {
  decision: 'alert' | 'recovered';
  freshness: CronFreshness;
}): string {
  const { decision, freshness } = input;
  const last =
    freshness.lastSuccessAt === null
      ? '最終成功: 記録なし'
      : `最終成功: ${freshness.lastSuccessAt}（${formatAge(freshness.ageSeconds)}前）`;

  if (decision === 'recovered') {
    return `[回復] WebScreen の保持期間バッチ（webscreen-beta-cron）が再び成功しました。\n${last}`;
  }
  return `[警告] WebScreen の保持期間バッチ（webscreen-beta-cron）が停止している可能性があります。期限切れの動画・キャプチャが消えずに溜まり続けます。\n${last}`;
}

/** 監視 cron の実行結果（entry 層の構造化ログにそのまま載せる）。 */
export interface CronAlertResult {
  decision: CronAlertDecision;
  freshness: CronFreshness;
  /** 通知を送ろうとして送れなかったか。true なら状態を記録せず次回に再送する。 */
  notifyFailed: boolean;
}

/**
 * 保持期間バッチの鮮度を見て、必要なら通知する。
 *
 * 送信に失敗した時は状態を記録しない。記録してしまうと「送ったつもり」で
 * 再通知の間隔に入り、次の 6 時間が無音になる。
 */
export async function runRetentionAlert(input: {
  database: CronRunDatabase;
  now: Date;
  notify: CronAlertNotifier;
}): Promise<CronAlertResult> {
  const { database, now, notify } = input;

  const freshness = evaluateFreshness(
    now,
    (await readRow(database, RETENTION_RUN_NAME))?.last_success_at ?? null
  );
  const lastAlert = parseAlertRecord(await readRow(database, RETENTION_ALERT_NAME));
  const decision = decideCronAlert({ now, stale: freshness.stale, lastAlert });

  if (decision === 'none') return { decision, freshness, notifyFailed: false };

  const delivered = await notify(buildAlertMessage({ decision, freshness }));
  if (!delivered) return { decision, freshness, notifyFailed: true };

  await recordCronRun({
    database,
    name: RETENTION_ALERT_NAME,
    at: now,
    summary: { state: decision === 'alert' ? 'alerting' : 'recovered' },
  });
  return { decision, freshness, notifyFailed: false };
}
