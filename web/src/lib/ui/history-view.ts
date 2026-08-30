/**
 * 履歴ドロップダウンとプレビューページが共有する、クライアント側の純粋な部分
 * （エンドポイントの組み立て・応答の読み取り・相対時刻の整形）。
 *
 * DOM 配線は history-menu.ts / preview-actions.ts が持つ。ここは入出力が値だけなので
 * bun test で検証する。
 */

import { MOVIE_STATUSES, type HistoryEntry, type MovieStatus } from '../contracts/api';

/** trailingSlash: 'always' のためスラッシュ必須。省くと 301 を挟む。 */
export const HISTORY_ENDPOINT = '/api/history/';

/** 削除（DELETE）の宛先。shortId は URL 経路に入るので encodeURIComponent する。 */
export function movieEndpoint(shortId: string): string {
  return `/api/movies/${encodeURIComponent(shortId)}/`;
}

/** pin 切り替え（POST）の宛先。 */
export function pinEndpoint(shortId: string): string {
  return `${movieEndpoint(shortId)}pin/`;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;

function asRecord(input: unknown): Record<string, unknown> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  return input as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readStatus(record: Record<string, unknown>): MovieStatus | null {
  const value = record['status'];
  if (typeof value !== 'string') return null;
  return (MOVIE_STATUSES as readonly string[]).includes(value) ? (value as MovieStatus) : null;
}

/**
 * 履歴応答の読み取り結果。dropped は形が違って読めなかった行数、
 * malformed は応答そのものが `{ movies: [...] }` の契約から外れていたこと。
 */
export interface HistoryParseResult {
  entries: HistoryEntry[];
  dropped: number;
  malformed: boolean;
}

/**
 * `GET /api/history/` の応答を読む。
 *
 * 形が違う行は捨てるが、件数を返して呼び出し側に判断させる。黙って間引くと、
 * 全件落ちた時に「履歴なし」と区別できず、履歴があるのに空として表示してしまう。
 * movies が配列でないトップレベルの契約違反も、0 件（履歴なし）に化けないよう
 * malformed で区別する。
 */
export function parseHistoryEntries(payload: unknown): HistoryParseResult {
  const record = asRecord(payload);
  const movies = record?.['movies'];
  if (!Array.isArray(movies)) return { entries: [], dropped: 0, malformed: true };

  const entries: HistoryEntry[] = [];
  let dropped = 0;
  for (const item of movies) {
    const row = asRecord(item);
    if (!row) {
      dropped += 1;
      continue;
    }

    const shortId = readString(row, 'shortId');
    const filename = readString(row, 'filename');
    const createdAt = readString(row, 'createdAt');
    const publicUrl = readString(row, 'publicUrl');
    const status = readStatus(row);
    if (!shortId || !filename || !createdAt || !publicUrl || !status) {
      dropped += 1;
      continue;
    }

    entries.push({
      shortId,
      filename,
      status,
      pinned: row['pinned'] === true,
      createdAt,
      expiresAt: readString(row, 'expiresAt'),
      publicUrl,
    });
  }
  return { entries, dropped, malformed: false };
}

/**
 * 保管期限までの残り日数（切り上げ）。期限切れ・解釈不能は 0 を返す。
 *
 * 切り上げなのは「あと 0 日」を避けるため。23 時間残っていれば「あと 1 日」と出す。
 */
export function remainingDays(expiresAt: string, now: Date): number {
  const timestamp = Date.parse(expiresAt);
  if (Number.isNaN(timestamp)) return 0;
  return Math.max(0, Math.ceil((timestamp - now.getTime()) / DAY_MS));
}

/**
 * 「3 分前」のような相対時刻。文言は Intl に任せ、辞書へロケール別の表現を持たない。
 *
 * 解釈できない日時は空文字を返す（行そのものは表示したいので例外にしない）。
 */
export function formatRelativeTime(isoDate: string, now: Date, locale: string): string {
  const timestamp = Date.parse(isoDate);
  if (Number.isNaN(timestamp)) return '';

  const elapsedMs = timestamp - now.getTime();
  const absoluteMs = Math.abs(elapsedMs);
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  if (absoluteMs < MINUTE_MS) return formatter.format(0, 'second');
  if (absoluteMs < HOUR_MS) return formatter.format(Math.trunc(elapsedMs / MINUTE_MS), 'minute');
  if (absoluteMs < DAY_MS) return formatter.format(Math.trunc(elapsedMs / HOUR_MS), 'hour');
  if (absoluteMs < MONTH_MS) return formatter.format(Math.trunc(elapsedMs / DAY_MS), 'day');
  return formatter.format(Math.trunc(elapsedMs / MONTH_MS), 'month');
}
