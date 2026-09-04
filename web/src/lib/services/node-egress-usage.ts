import type { MediaMtxClient } from '../infra/mediamtx';
import type { CronAlertNotifier } from './cron-health';

const SOURCE = 'webscreen-node-egress-usage';
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const BYTE_PER_GB = 1_000_000_000;
const LIVE_PATH = /^live\/[A-Za-z0-9]{12}$/;

export interface NodeEgressUsageDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): NodeEgressUsageStatement;
  };
  batch(statements: NodeEgressUsageStatement[]): Promise<Array<{ meta: { changes: number } }>>;
}

/** D1PreparedStatement の、このserviceが使う最小操作面。 */
export interface NodeEgressUsageStatement {
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface NodeEgressUsageSummary {
  nodesSampled: number;
  nodesFailed: number;
  bytesAdded: number;
  alertsSent: number;
  pathsSkipped: number;
}

interface SampleRow {
  path: string;
  bytes_sent: number;
}

interface DailyRow {
  bytes_sent: number;
  alerted_level: number;
}

/** 各read egressのpathカウンタを日次加算し、閾値到達を一度だけ通知する。 */
export async function recordNodeEgressUsage(input: {
  database: NodeEgressUsageDatabase;
  nodes: Array<{ nodeKey: string; client: MediaMtxClient }>;
  now: Date;
  dailyLimitBytes: number;
  notify: CronAlertNotifier;
}): Promise<NodeEgressUsageSummary> {
  if (!Number.isSafeInteger(input.dailyLimitBytes) || input.dailyLimitBytes <= 0) {
    throw new Error('Invalid node egress daily limit');
  }

  const summary: NodeEgressUsageSummary = {
    nodesSampled: 0,
    nodesFailed: 0,
    bytesAdded: 0,
    alertsSent: 0,
    pathsSkipped: 0,
  };
  const day = jstDay(input.now);

  for (const node of input.nodes) {
    let paths;
    try {
      paths = await node.client.listPaths();
    } catch (error) {
      summary.nodesFailed += 1;
      logNodeSampleFailure(error, input.now);
      continue;
    }

    const result = await recordNode({ ...input, node, paths, day });
    summary.nodesSampled += 1;
    summary.bytesAdded += result.bytesAdded;
    summary.alertsSent += result.alertSent ? 1 : 0;
    summary.pathsSkipped += result.pathsSkipped;
  }

  return summary;
}

async function recordNode(input: {
  database: NodeEgressUsageDatabase;
  node: { nodeKey: string; client: MediaMtxClient };
  paths: Awaited<ReturnType<MediaMtxClient['listPaths']>>;
  now: Date;
  day: string;
  dailyLimitBytes: number;
  notify: CronAlertNotifier;
}): Promise<{ bytesAdded: number; alertSent: boolean; pathsSkipped: number }> {
  const samples = await input.database
    .prepare('SELECT path, bytes_sent FROM node_egress_samples WHERE node_key = ?')
    .bind(input.node.nodeKey)
    .all<SampleRow>();
  const previousByPath = new Map(samples.results.map((sample) => [sample.path, sample.bytes_sent]));
  const currentByPath = new Map<string, number>();
  const observedPathNames = new Set<string>();
  let pathsSkipped = 0;
  for (const path of input.paths) {
    observedPathNames.add(path.name);
    const bytesSent = path.bytesSent;
    if (
      !LIVE_PATH.test(path.name) ||
      typeof bytesSent !== 'number' ||
      !Number.isSafeInteger(bytesSent) ||
      bytesSent < 0
    ) {
      pathsSkipped += 1;
      continue;
    }
    currentByPath.set(path.name, bytesSent);
  }
  if (pathsSkipped > 0) logInvalidPathsSkipped(pathsSkipped, input.now);
  let bytesAdded = 0;
  const statements: NodeEgressUsageStatement[] = [];

  for (const [path, bytesSent] of currentByPath) {
    const previous = previousByPath.get(path);
    // MediaMTXは再起動・path再生成で生涯カウンタを0へ戻すため、下がった値は新しい累積値として足す。
    // 誤差は1分未満で、導入初回はpath生涯値（本番は最長15分）を当日分に加算する。
    bytesAdded += previous === undefined || bytesSent < previous ? bytesSent : bytesSent - previous;
    statements.push(
      input.database
        .prepare(
          `INSERT INTO node_egress_daily (node_key, day, bytes_sent, alerted_level, updated_at)
           VALUES (?, ?, (
             SELECT CASE WHEN s.bytes_sent IS NULL OR ? < s.bytes_sent THEN ? ELSE ? - s.bytes_sent END
             FROM (SELECT ? AS node_key) x
             LEFT JOIN node_egress_samples s ON s.node_key = x.node_key AND s.path = ?
           ), 0, ?)
           ON CONFLICT(node_key, day) DO UPDATE SET
             bytes_sent = node_egress_daily.bytes_sent + excluded.bytes_sent,
             updated_at = excluded.updated_at`
        )
        .bind(
          input.node.nodeKey,
          input.day,
          bytesSent,
          bytesSent,
          bytesSent,
          input.node.nodeKey,
          path,
          input.now.toISOString()
        )
    );
    // 差分は同じbatch内でsampleを更新する直前にSQLで計算し、並行実行でも二重加算を避ける。
    statements.push(
      input.database
        .prepare(
          `INSERT INTO node_egress_samples (node_key, path, bytes_sent, sampled_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(node_key, path) DO UPDATE SET
             bytes_sent = excluded.bytes_sent,
             sampled_at = excluded.sampled_at`
        )
        .bind(input.node.nodeKey, path, bytesSent, input.now.toISOString())
    );
  }

  for (const sample of samples.results) {
    if (observedPathNames.has(sample.path)) continue;
    // 消えたpathの最後の1分未満は観測できないため、その分は意図して捨てる。
    statements.push(
      input.database
        .prepare('DELETE FROM node_egress_samples WHERE node_key = ? AND path = ?')
        .bind(input.node.nodeKey, sample.path)
    );
  }

  if (statements.length === 0) return { bytesAdded, alertSent: false, pathsSkipped };
  await input.database.batch(statements);

  if (currentByPath.size === 0) return { bytesAdded, alertSent: false, pathsSkipped };

  const daily = await input.database
    .prepare(
      'SELECT bytes_sent, alerted_level FROM node_egress_daily WHERE node_key = ? AND day = ?'
    )
    .bind(input.node.nodeKey, input.day)
    .all<DailyRow>();
  const row = daily.results[0];
  if (row === undefined) throw new Error('Node egress daily row was not recorded');

  const level = alertLevel(row.bytes_sent, input.dailyLimitBytes);
  if (level === 0 || level <= row.alerted_level) {
    return { bytesAdded, alertSent: false, pathsSkipped };
  }

  const claimed = await input.database
    .prepare(
      `UPDATE node_egress_daily SET alerted_level = ?
       WHERE node_key = ? AND day = ? AND alerted_level < ?`
    )
    .bind(level, input.node.nodeKey, input.day, level)
    .run();
  if (claimed.meta.changes !== 1) return { bytesAdded, alertSent: false, pathsSkipped };

  // 送信成功が確認できた時だけ確定。失敗時は巻き戻して翌分に再試行する。
  // webhook未設定なら毎分warnが出るが、それは設定漏れを可視化する意図である。
  const delivered = await notifyAlert(input.notify, buildAlertMessage({
    nodeKey: input.node.nodeKey,
    day: input.day,
    bytesSent: row.bytes_sent,
    dailyLimitBytes: input.dailyLimitBytes,
  }), input.now);
  if (!delivered) {
    await input.database
      .prepare(
        `UPDATE node_egress_daily SET alerted_level = ?
         WHERE node_key = ? AND day = ? AND alerted_level = ?`
      )
      .bind(row.alerted_level, input.node.nodeKey, input.day, level)
      .run();
  }
  return { bytesAdded, alertSent: delivered, pathsSkipped };
}

function alertLevel(bytesSent: number, dailyLimitBytes: number): 0 | 70 | 85 | 95 {
  const percent = (bytesSent * 100) / dailyLimitBytes;
  if (percent >= 95) return 95;
  if (percent >= 85) return 85;
  if (percent >= 70) return 70;
  return 0;
}

function jstDay(now: Date): string {
  // Indigoの1日の境界は未確認のため、運用上の仮定としてJSTで日次行を切る。
  return new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

function buildAlertMessage(input: {
  nodeKey: string;
  day: string;
  bytesSent: number;
  dailyLimitBytes: number;
}): string {
  const usedGb = (input.bytesSent / BYTE_PER_GB).toFixed(1);
  const limitGb = (input.dailyLimitBytes / BYTE_PER_GB).toFixed(1);
  const percent = ((input.bytesSent * 100) / input.dailyLimitBytes).toFixed(1);
  return `[警告] egress ${input.nodeKey} (${input.day}) の転送量: ${usedGb} GB / ${limitGb} GB (${percent}%)`;
}

async function notifyAlert(notify: CronAlertNotifier, message: string, now: Date): Promise<boolean> {
  try {
    const delivered = await notify(message);
    if (delivered) return true;
    logAlertDeliveryFailure('notification returned false', now);
  } catch (error) {
    logAlertDeliveryFailure(error instanceof Error ? error.name : 'UnknownError', now);
  }
  return false;
}

function logNodeSampleFailure(error: unknown, now: Date): void {
  console.error(
    JSON.stringify({
      timestamp: now.toISOString(),
      source: SOURCE,
      severity: 'error',
      kind: 'event',
      event: 'node_egress_sample_failed',
      errorName: error instanceof Error ? error.name : 'UnknownError',
      summary: 'A read egress path sample failed; other nodes continue and this node retries next run.',
    })
  );
}

function logInvalidPathsSkipped(pathsSkipped: number, now: Date): void {
  console.warn(
    JSON.stringify({
      timestamp: now.toISOString(),
      source: SOURCE,
      severity: 'warn',
      kind: 'event',
      event: 'node_egress_paths_skipped',
      pathsSkipped,
      summary: 'Invalid MediaMTX path counters were excluded from node egress usage.',
    })
  );
}

function logAlertDeliveryFailure(errorName: string, now: Date): void {
  console.warn(
    JSON.stringify({
      timestamp: now.toISOString(),
      source: SOURCE,
      severity: 'warn',
      kind: 'event',
      event: 'node_egress_alert_delivery_failed',
      errorName,
      summary: 'A node egress alert was not delivered; its claim was rolled back for the next run.',
    })
  );
}
