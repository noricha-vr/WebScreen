/**
 * ヘッダーの履歴ドロップダウンの DOM 配線。
 *
 * 表示文言は HTML 側（辞書由来のテンプレート）にあり、ここは値の差し込みと
 * 状態の切り替えだけを行う。開くたびに取得し直すのは、別タブでの変換・削除の結果を
 * 古い一覧のまま見せないため。
 */

import type { HistoryEntry } from '../contracts/api';
import { reportClientError, reportRequestFailure } from './client-error-report';
import {
  HISTORY_ENDPOINT,
  formatRelativeTime,
  movieEndpoint,
  parseHistoryEntries,
} from './history-view';
import { isUnauthorizedRequestError, requestJson } from './request-json';

type HistoryState = 'loading' | 'ready' | 'empty' | 'error';

function setState(root: HTMLElement, state: HistoryState): void {
  root.dataset['historyState'] = state;
}

function requestFailureMessage(root: HTMLElement, error: unknown, fallback: string): string {
  return isUnauthorizedRequestError(error) ? (root.dataset['msgSessionExpired'] ?? fallback) : fallback;
}

function fillRow(
  row: HTMLElement,
  entry: HistoryEntry,
  locale: string,
  now: Date
): void {
  row.dataset['shortId'] = entry.shortId;

  const link = row.querySelector<HTMLAnchorElement>('[data-entry-link]');
  if (link) link.href = `/${entry.shortId}/`;

  const name = row.querySelector<HTMLElement>('[data-entry-name]');
  if (name) name.textContent = entry.filename;

  const time = row.querySelector<HTMLElement>('[data-entry-time]');
  if (time) time.textContent = formatRelativeTime(entry.createdAt, now, locale);

  const pin = row.querySelector<HTMLElement>('[data-entry-pinned]');
  if (pin) pin.hidden = !entry.pinned;
}

/** 削除の 2 段階確認（トリガー → 確認 → 実行）。confirm() は使わない。 */
function wireDelete(row: HTMLElement, root: HTMLElement, fetchImpl: typeof fetch): void {
  const shortId = row.dataset['shortId'] ?? '';
  const failure = row.querySelector<HTMLElement>('[data-delete-failed]');

  row.querySelector<HTMLButtonElement>('[data-delete-trigger]')?.addEventListener('click', () => {
    row.dataset['confirming'] = 'true';
    if (failure) failure.hidden = true;
  });

  row.querySelector<HTMLButtonElement>('[data-delete-cancel]')?.addEventListener('click', () => {
    delete row.dataset['confirming'];
  });

  row.querySelector<HTMLButtonElement>('[data-delete-yes]')?.addEventListener('click', () => {
    void (async () => {
      let error: unknown;
      try {
        await requestJson(movieEndpoint(shortId), {
          method: 'DELETE',
          credentials: 'same-origin',
        }, fetchImpl);
      } catch (requestError) {
        error = requestError;
        reportRequestFailure('delete', requestError);
      }

      if (error !== undefined) {
        delete row.dataset['confirming'];
        if (failure) {
          failure.textContent = requestFailureMessage(root, error, root.dataset['msgDeleteFailed'] ?? '');
          failure.hidden = false;
        }
        return;
      }

      const list = row.parentElement;
      row.remove();
      if (list && list.children.length === 0) setState(root, 'empty');
    })();
  });
}

function render(root: HTMLElement, entries: HistoryEntry[], fetchImpl: typeof fetch): void {
  const list = root.querySelector<HTMLElement>('[data-history-list]');
  const template = root.querySelector<HTMLTemplateElement>('[data-history-item]');
  if (!list || !template) return;

  list.replaceChildren();
  if (entries.length === 0) {
    setState(root, 'empty');
    return;
  }

  const locale = root.dataset['locale'] ?? 'ja';
  const now = new Date();
  for (const entry of entries) {
    const fragment = template.content.cloneNode(true) as DocumentFragment;
    const row = fragment.querySelector<HTMLElement>('[data-history-row]');
    if (!row) continue;

    fillRow(row, entry, locale, now);
    wireDelete(row, root, fetchImpl);
    list.append(fragment);
  }
  setState(root, 'ready');
}

function showError(root: HTMLElement, message: string): void {
  const element = root.querySelector<HTMLElement>('[data-history-error-message]');
  if (element) element.textContent = message;
  setState(root, 'error');
}

async function load(root: HTMLElement, fetchImpl: typeof fetch): Promise<void> {
  setState(root, 'loading');

  let payload: unknown;
  try {
    payload = await requestJson(HISTORY_ENDPOINT, { credentials: 'same-origin' }, fetchImpl);
  } catch (error) {
    reportRequestFailure('history', error);
    showError(root, requestFailureMessage(root, error, root.dataset['msgHistoryFailed'] ?? ''));
    return;
  }

  const { entries, dropped, malformed } = parseHistoryEntries(payload);
  if (malformed || dropped > 0) {
    // 読めた行だけ出すと、全件落ちた時に「履歴なし」と見分けが付かない。
    console.error(malformed ? 'history_payload_malformed' : `history_entries_dropped: ${dropped}`);
    // 応答は 200 なので通信の失敗としては見えない。中身が壊れていることは
    // console だけでなくサーバー側にも残す（送るのは段とコードだけ）。
    reportClientError({ stage: 'history', errorCode: 'failed' });
    showError(root, root.dataset['msgHistoryFailed'] ?? '');
    return;
  }

  render(root, entries, fetchImpl);
}

/** `<details data-history-menu>` に配線する。開いた時に一覧を取得する。 */
export function mountHistoryMenu(root: HTMLDetailsElement, fetchImpl: typeof fetch = fetch): void {
  root.addEventListener('toggle', () => {
    if (root.open) void load(root, fetchImpl);
  });

  // details はネイティブでは外側クリックで閉じないので document 側で拾う。
  // contains() ではなく composedPath() を見るのは、行の削除が先に row.remove() を
  // 走らせた場合にクリック対象が DOM から外れ、内側のクリックが「外側」と誤判定される
  // ため（composedPath は dispatch 時点の経路を保持する）。
  // note: 解除口は設けていない。MPA なのでページ遷移ごとに 1 回しか mount されない
  document.addEventListener('click', (event) => {
    if (!root.open) return;
    if (event.composedPath().includes(root)) return;
    root.open = false;
  });
}
