import type { MediaMtxClient } from '../infra/mediamtx';
import type { CronAlertNotifier } from './cron-health';

const SOURCE = 'webscreen-node-egress-usage';
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const BYTE_PER_GB = 1_000_000_000;

export interface NodeEgressUsageDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}

export interface NodeEgressUsageSummary {
  nodesSampled: number;
  nodesFailed: number;
  bytesAdded: number;
  alertsSent: number;
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
}): Promise<{ bytesAdded: number; alertSent: boolean }> {
  const samples = await input.database
    .prepare('SELECT path, bytes_sent FROM node_egress_samples WHERE node_key = ?')
    .bind(input.node.nodeKey)
    .all<SampleRow>();
  const previousByPath = new Map(samples.results.map((sample) => [sample.path, sample.bytes_sent]));
  const currentByPath = new Map(
    input.paths.map((path) => [path.name, Math.floor(path.bytesSent ?? 0)])
  );
  let bytesAdded = 0;

  for (const [path, bytesSent] of currentByPath) {
    const previous = previousByPath.get(path);
    // MediaMTXは再起動・path再生成で生涯カウンタを0へ戻すため、下がった値は新しい累積値として足す。
    bytesAdded += previous === undefined || bytesSent < previous ? bytesSent : bytesSent - previous;
    await input.database
      .prepare(
        `INSERT INTO node_egress_samples (node_key, path, bytes_sent, sampled_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(node_key, path) DO UPDATE SET
           bytes_sent = excluded.bytes_sent,
           sampled_at = excluded.sampled_at`
      )
      .bind(input.node.nodeKey, path, bytesSent, input.now.toISOString())
      .run();
  }

  for (const sample of samples.results) {
    if (currentByPath.has(sample.path)) continue;
    // 消えたpathの最後の1分未満は観測できないため、その分は意図して捨てる。
    await input.database
      .prepare('DELETE FROM node_egress_samples WHERE node_key = ? AND path = ?')
      .bind(input.node.nodeKey, sample.path)
      .run();
  }

  await input.database
    .prepare(
      `INSERT INTO node_egress_daily (node_key, day, bytes_sent, alerted_level, updated_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT(node_key, day) DO UPDATE SET
         bytes_sent = node_egress_daily.bytes_sent + excluded.bytes_sent,
         updated_at = excluded.updated_at`
    )
    .bind(input.node.nodeKey, input.day, bytesAdded, input.now.toISOString())
    .run();

  const daily = await input.database
    .prepare(
      'SELECT bytes_sent, alerted_level FROM node_egress_daily WHERE node_key = ? AND day = ?'
    )
    .bind(input.node.nodeKey, input.day)
    .all<DailyRow>();
  const row = daily.results[0];
  if (row === undefined) throw new Error('Node egress daily row was not recorded');

  const level = alertLevel(row.bytes_sent, input.dailyLimitBytes);
  if (level === 0 || level <= row.alerted_level) return { bytesAdded, alertSent: false };

  const claimed = await input.database
    .prepare(
      `UPDATE node_egress_daily SET alerted_level = ?
       WHERE node_key = ? AND day = ? AND alerted_level < ?`
    )
    .bind(level, input.node.nodeKey, input.day, level)
    .run();
  if (claimed.meta.changes !== 1) return { bytesAdded, alertSent: false };

  // 連投で通知先を埋めるより、送信失敗時の一度の取りこぼしを選ぶ。
  const delivered = await notifyAlert(input.notify, buildAlertMessage({
    nodeKey: input.node.nodeKey,
    day: input.day,
    bytesSent: row.bytes_sent,
    dailyLimitBytes: input.dailyLimitBytes,
  }), input.now);
  return { bytesAdded, alertSent: delivered };
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

function logAlertDeliveryFailure(errorName: string, now: Date): void {
  console.warn(
    JSON.stringify({
      timestamp: now.toISOString(),
      source: SOURCE,
      severity: 'warn',
      kind: 'event',
      event: 'node_egress_alert_delivery_failed',
      errorName,
      summary: 'A node egress alert was not delivered; its claimed level remains recorded to prevent repeated alerts.',
    })
  );
}
