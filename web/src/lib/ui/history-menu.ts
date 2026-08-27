/**
 * ヘッダーの履歴ドロップダウンの DOM 配線。
 *
 * 表示文言は HTML 側（辞書由来のテンプレート）にあり、ここは値の差し込みと
 * 状態の切り替えだけを行う。開くたびに取得し直すのは、別タブでの変換・削除の結果を
 * 古い一覧のまま見せないため。
 */

import type { HistoryEntry } from '../contracts/api';
import {
  HISTORY_ENDPOINT,
  formatRelativeTime,
  movieEndpoint,
  parseHistoryEntries,
} from './history-view';

type HistoryState = 'loading' | 'ready' | 'empty' | 'error';

function setState(root: HTMLElement, state: HistoryState): void {
  root.dataset['historyState'] = state;
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

  const processing = row.querySelector<HTMLElement>('[data-entry-processing]');
  if (processing) processing.hidden = entry.status !== 'pending';
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
      let ok = false;
      try {
        const response = await fetchImpl(movieEndpoint(shortId), {
          method: 'DELETE',
          credentials: 'same-origin',
        });
        ok = response.ok;
      } catch {
        ok = false;
      }

      if (!ok) {
        delete row.dataset['confirming'];
        if (failure) failure.hidden = false;
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

async function load(root: HTMLElement, fetchImpl: typeof fetch): Promise<void> {
  setState(root, 'loading');

  let payload: unknown;
  try {
    const response = await fetchImpl(HISTORY_ENDPOINT, { credentials: 'same-origin' });
    if (!response.ok) {
      setState(root, 'error');
      return;
    }
    payload = await response.json();
  } catch {
    setState(root, 'error');
    return;
  }

  render(root, parseHistoryEntries(payload), fetchImpl);
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
