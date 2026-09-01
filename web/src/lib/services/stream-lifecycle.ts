import type { StreamEndReason } from '../contracts/api';
import type { MediaMtxClient, MediaPath } from '../infra/mediamtx';

export interface StreamLifecycleDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta: { changes: number } }>;
    };
  };
}

export interface StreamLifecycleSettings {
  noViewerTimeoutSeconds: number;
  heartbeatTimeoutSeconds: number;
}

export interface StreamLifecycleSummary {
  endedByExtendTimeout: number;
  endedByHeartbeatLost: number;
  endedByNoViewers: number;
  viewersObserved: number;
  publishersKicked: number;
  kickPendingCleared: number;
}

interface LifecycleRow {
  id: string;
  status: 'live' | 'ended';
  extend_expires_at: string;
  last_heartbeat_at: string;
  last_viewer_at: string;
  kick_pending: 0 | 1;
}

/** 3 層の停止判定と MediaMTX publisher の再 kick を実行する。 */
export async function runStreamLifecycle(input: {
  database: StreamLifecycleDatabase;
  /** 旧単一 endpoint。split endpoint 未設定時だけ ingress / egress の両方として使う。 */
  mediaMtx?: MediaMtxClient;
  ingressMediaMtx?: MediaMtxClient;
  egressMediaMtx?: MediaMtxClient;
  settings: StreamLifecycleSettings;
  now: Date;
}): Promise<StreamLifecycleSummary> {
  const summary = emptySummary();
  const newlyEnded = new Set<string>();
  const initialRows = await listRelevant(input.database);
  if (initialRows.length === 0) return summary;

  for (const row of initialRows) {
    if (row.status !== 'live') continue;
    if (row.extend_expires_at <= input.now.toISOString()) {
      const ended = await endStream(
        input.database,
        row,
        input.now,
        'extend_timeout'
      );
      summary.endedByExtendTimeout += ended;
      if (ended) newlyEnded.add(row.id);
      continue;
    }
    const heartbeatCutoff = subtractSeconds(
      input.now,
      input.settings.heartbeatTimeoutSeconds
    ).toISOString();
    if (row.last_heartbeat_at <= heartbeatCutoff) {
      const ended = await endStream(
        input.database,
        row,
        input.now,
        'heartbeat_lost'
      );
      summary.endedByHeartbeatLost += ended;
      if (ended) newlyEnded.add(row.id);
    }
  }

  const rowsAfterD1Checks = await listRelevant(input.database);
  if (rowsAfterD1Checks.length === 0) return summary;
  const mediaMtx = resolveMediaMtx(input);
  if (!mediaMtx) throw new Error('MediaMTX configuration is required for active streams');

  const ingressPaths = await mediaMtx.ingress.listPaths();
  const egressPaths =
    mediaMtx.egress === mediaMtx.ingress
      ? ingressPaths
      : await mediaMtx.egress.listPaths();
  const ingressByName = new Map(ingressPaths.map((path) => [path.name, path]));
  const egressByName = new Map(egressPaths.map((path) => [path.name, path]));
  await applyViewerChecks(input, rowsAfterD1Checks, egressByName, summary, newlyEnded);
  await processPendingKicks(input, mediaMtx.ingress, ingressByName, egressByName, newlyEnded, summary);
  return summary;
}

async function applyViewerChecks(
  input: {
    database: StreamLifecycleDatabase;
    settings: StreamLifecycleSettings;
    now: Date;
  },
  rows: LifecycleRow[],
  paths: Map<string, MediaPath>,
  summary: StreamLifecycleSummary,
  newlyEnded: Set<string>
): Promise<void> {
  const viewerCutoff = subtractSeconds(
    input.now,
    input.settings.noViewerTimeoutSeconds
  ).toISOString();
  for (const row of rows) {
    if (row.status !== 'live') continue;
    const path = paths.get(`live/${row.id}`);
    if ((path?.rtspReaders ?? 0) > 0) {
      const result = await input.database
        .prepare(
          `UPDATE stream_sessions SET last_viewer_at = ?
           WHERE id = ? AND status = 'live'`
        )
        .bind(input.now.toISOString(), row.id)
        .run();
      summary.viewersObserved += result.meta.changes;
      continue;
    }
    if (row.last_viewer_at > viewerCutoff) continue;
    const ended = await endStream(
      input.database,
      row,
      input.now,
      'no_viewers'
    );
    summary.endedByNoViewers += ended;
    if (ended) newlyEnded.add(row.id);
  }
}

async function processPendingKicks(
  input: {
    database: StreamLifecycleDatabase;
  },
  ingress: MediaMtxClient,
  ingressPaths: Map<string, MediaPath>,
  egressPaths: Map<string, MediaPath>,
  newlyEnded: Set<string>,
  summary: StreamLifecycleSummary
): Promise<void> {
  const pending = (await listRelevant(input.database)).filter(
    (row) => row.status === 'ended' && row.kick_pending === 1
  );
  for (const row of pending) {
    const pathName = `live/${row.id}`;
    const ingressPath = ingressPaths.get(pathName);
    if (ingressPath?.publisherId && ingressPath.publisherSessionType) {
      await ingress.kickPublisher({
        id: ingressPath.publisherId,
        sessionType: ingressPath.publisherSessionType,
      });
      summary.publishersKicked += 1;
      continue;
    }
    if (newlyEnded.has(row.id) || ingressPath || egressPaths.has(pathName)) continue;
    const cleared = await input.database
      .prepare(
        `UPDATE stream_sessions SET kick_pending = 0
         WHERE id = ? AND status = 'ended' AND kick_pending = 1`
      )
      .bind(row.id)
      .run();
    summary.kickPendingCleared += cleared.meta.changes;
  }
}

function resolveMediaMtx(input: {
  mediaMtx?: MediaMtxClient;
  ingressMediaMtx?: MediaMtxClient;
  egressMediaMtx?: MediaMtxClient;
}): { ingress: MediaMtxClient; egress: MediaMtxClient } | undefined {
  if (input.ingressMediaMtx && input.egressMediaMtx) {
    return { ingress: input.ingressMediaMtx, egress: input.egressMediaMtx };
  }
  if (input.mediaMtx) return { ingress: input.mediaMtx, egress: input.mediaMtx };
  return undefined;
}

async function endStream(
  database: StreamLifecycleDatabase,
  row: LifecycleRow,
  now: Date,
  reason: Exclude<StreamEndReason, 'user_stop'>
): Promise<number> {
  const conditions =
    reason === 'extend_timeout'
      ? 'extend_expires_at = ? AND extend_expires_at <= ?'
      : reason === 'heartbeat_lost'
        ? 'extend_expires_at = ? AND last_heartbeat_at = ? AND extend_expires_at > ?'
        : 'extend_expires_at = ? AND last_heartbeat_at = ? AND last_viewer_at = ?';
  const values =
    reason === 'extend_timeout'
      ? [row.extend_expires_at, now.toISOString()]
      : reason === 'heartbeat_lost'
        ? [row.extend_expires_at, row.last_heartbeat_at, now.toISOString()]
        : [row.extend_expires_at, row.last_heartbeat_at, row.last_viewer_at];
  const result = await database
    .prepare(
      `UPDATE stream_sessions
       SET status = 'ended', ended_at = ?, end_reason = ?, kick_pending = 1
       WHERE id = ? AND status = 'live' AND ${conditions}`
    )
    .bind(now.toISOString(), reason, row.id, ...values)
    .run();
  return result.meta.changes;
}

async function listRelevant(database: StreamLifecycleDatabase): Promise<LifecycleRow[]> {
  const result = await database
    .prepare(
      `SELECT id, status, extend_expires_at, last_heartbeat_at, last_viewer_at, kick_pending
       FROM stream_sessions WHERE status = 'live' OR kick_pending = 1`
    )
    .bind()
    .all<LifecycleRow>();
  return result.results;
}

function emptySummary(): StreamLifecycleSummary {
  return {
    endedByExtendTimeout: 0,
    endedByHeartbeatLost: 0,
    endedByNoViewers: 0,
    viewersObserved: 0,
    publishersKicked: 0,
    kickPendingCleared: 0,
  };
}

function subtractSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() - seconds * 1000);
}
