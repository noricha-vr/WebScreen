const SQLITE_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * D1 の movies 日時を ISO8601（UTC）に揃える。
 *
 * datetime('now') の空白区切り文字列を Date に直接渡すとローカル時刻として解釈され、
 * workerd（UTC）と開発機（JST）でずれるため、UTC を明示してから変換する。
 */
export function toMovieIsoString(value: string): string {
  const normalized = SQLITE_DATETIME_PATTERN.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('movies の日時カラムを解釈できません');
  }
  return parsed.toISOString();
}
