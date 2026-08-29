/**
 * 期限付きのお知らせ枠の表示/ 非表示を決める。
 *
 * ページは静的生成（output: 'static'）なので、テンプレート側で `new Date()` を評価すると
 * ビルド時刻で結果が固定され、期限が来ても枠が消えない。判定は描画後にブラウザで行う。
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD` を UTC の 0 時として解釈する。日付として成立しない値は null を返す。
 *
 * `Date.UTC` は 13 月や 32 日を翌月へ繰り上げてしまうため、往復させて一致を確認する。
 */
function parseUtcDate(value: string): number | null {
  const matched = DATE_PATTERN.exec(value);
  if (!matched) return null;

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);

  const rolledOver =
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day;

  return rolledOver ? null : timestamp;
}

/**
 * `until`（`YYYY-MM-DD`）を過ぎているか。当日いっぱいは表示し、翌日 0 時から期限切れとする。
 *
 * 境界は UTC で見る。閲覧者のタイムゾーンで判定すると同じ静的 HTML が地域ごとに違う
 * 出方をし、テストも実行環境依存になる。お知らせの性質上、数時間のずれは問題にならない。
 *
 * 日付として読めない値は「期限切れではない」に倒す（文字列の書き間違いで告知が
 * 黙って消えるより、出続けて気づける方が害が小さい）。
 */
export function isNoticeExpired(until: string, now: Date): boolean {
  const timestamp = parseUtcDate(until);
  if (timestamp === null) return false;

  return now.getTime() >= timestamp + MS_PER_DAY;
}

/**
 * `mountNotice` が触る最小の面。
 *
 * `HTMLElement` 全体を要求しないのは、配線（data 属性の読みと hidden の反映）を
 * DOM 実装なしでテストするため。実行時は HTMLElement をそのまま渡せる。
 */
export interface NoticeElement {
  dataset: DOMStringMap;
  hidden: boolean;
}

/** `data-notice-until` を読み、期限切れなら枠を隠す。 */
export function mountNotice(element: NoticeElement, now: Date = new Date()): void {
  const until = element.dataset['noticeUntil'];
  if (until === undefined) return;

  element.hidden = isNoticeExpired(until, now);
}
