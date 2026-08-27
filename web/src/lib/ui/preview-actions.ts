/**
 * プレビューページ（/{shortId}/）の DOM 配線。
 *
 * URL コピーは全員に、pin と削除は所有者だけに出す（HTML 自体をサーバー側で出し分ける）。
 * 文言は HTML に埋め込まれた辞書の値を読むだけで、ここに日本語 / 英語を書かない。
 */

import { MAX_FILENAME_LENGTH } from '../contracts/api';
import { copyToClipboard } from './clipboard';
import { AUTO_COPY_FEEDBACK_DELAY_MS, consumeAutoCopy, type SessionStorage } from './auto-copy';
import { movieEndpoint, pinEndpoint } from './history-view';

// 遷移直後の自動コピーでも見逃しにくい長さ（2000ms は短すぎるとの報告で延長）
const COPIED_FEEDBACK_MS = 4000;
const RENAME_SAVED_FEEDBACK_MS = 2000;

type Schedule = (callback: () => void, delayMs: number) => void;

export interface PreviewActionsOptions {
  fetchImpl?: typeof fetch;
  schedule?: Schedule;
  /** pin 成功後の再読み込み。保管期限の表示はサーバーが持つので画面を作り直す。 */
  reload?: () => void;
  /** 自動コピー要求の保存先（既定は sessionStorage）。 */
  storage?: SessionStorage;
}

function find<T extends HTMLElement>(root: HTMLElement, selector: string): T | null {
  return root.querySelector<T>(selector);
}

function showCopied(root: HTMLElement, schedule: Schedule): void {
  root.dataset['copied'] = 'true';
  schedule(() => {
    delete root.dataset['copied'];
  }, COPIED_FEEDBACK_MS);
}

function wireCopy(root: HTMLElement, schedule: Schedule): void {
  const input = find<HTMLInputElement>(root, '[data-preview-url]');
  find<HTMLButtonElement>(root, '[data-copy-button]')?.addEventListener('click', () => {
    void copyToClipboard(input?.value ?? '', input).then((copied) => {
      if (copied) showCopied(root, schedule);
    });
  });
}

function wirePin(root: HTMLElement, fetchImpl: typeof fetch, reload: () => void): void {
  const button = find<HTMLButtonElement>(root, '[data-pin-button]');
  if (!button) return;

  const failure = find<HTMLElement>(root, '[data-pin-failed]');
  const shortId = root.dataset['shortId'] ?? '';

  button.addEventListener('click', () => {
    void (async () => {
      button.disabled = true;
      if (failure) failure.hidden = true;

      let status = 0;
      try {
        const response = await fetchImpl(pinEndpoint(shortId), {
          method: 'POST',
          credentials: 'same-origin',
        });
        status = response.status;
      } catch {
        status = 0;
      }

      if (status >= 200 && status < 300) {
        reload();
        return;
      }

      button.disabled = false;
      if (!failure) return;
      // 409 は「上限に達した」で、それ以外は汎用の失敗として扱う
      failure.textContent =
        status === 409 ? (root.dataset['msgPinLimit'] ?? '') : (root.dataset['msgPinFailed'] ?? '');
      failure.hidden = false;
    })();
  });
}

function wireRename(root: HTMLElement, fetchImpl: typeof fetch, schedule: Schedule): void {
  const button = find<HTMLButtonElement>(root, '[data-rename-button]');
  const input = find<HTMLInputElement>(root, '[data-filename-input]');
  const text = find<HTMLElement>(root, '[data-filename-text]');
  if (!button || !input || !text) return;

  const failure = find<HTMLElement>(root, '[data-rename-failed]');
  const shortId = root.dataset['shortId'] ?? '';
  const titleSuffix = root.dataset['documentTitleSuffix'] ?? '';
  let originalFilename = text.textContent ?? '';

  const setState = (state: 'idle' | 'editing' | 'saving' | 'saved'): void => {
    root.dataset['renameState'] = state;
    input.disabled = state === 'saving';
    button.setAttribute(
      'aria-label',
      state === 'idle'
        ? (root.dataset['labelRename'] ?? '')
        : state === 'saved'
          ? (root.dataset['labelRenameSaved'] ?? '')
          : (root.dataset['labelRenameSave'] ?? '')
    );
  };

  const cancel = (): void => {
    input.value = originalFilename;
    setState('idle');
  };

  const save = (): void => {
    if (root.dataset['renameState'] === 'saving') return;

    const filename = input.value.trim();
    if (filename.length === 0 || filename === originalFilename) {
      cancel();
      return;
    }

    // 長すぎは送信前に弾き、理由と現在の文字数を出す（サーバー 400 は防御層として残る）。
    if (filename.length > MAX_FILENAME_LENGTH) {
      if (failure) {
        failure.textContent = (root.dataset['msgRenameTooLong'] ?? '').replace(
          '{count}',
          String(filename.length)
        );
        failure.hidden = false;
      }
      input.focus();
      return;
    }

    void (async () => {
      setState('saving');
      button.disabled = true;
      if (failure) failure.hidden = true;

      let ok = false;
      try {
        const response = await fetchImpl(movieEndpoint(shortId), {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filename }),
        });
        ok = response.ok;
      } catch {
        ok = false;
      }

      button.disabled = false;
      if (!ok) {
        if (failure) {
          failure.textContent = root.dataset['msgRenameFailed'] ?? '';
          failure.hidden = false;
        }
        setState('editing');
        input.focus();
        return;
      }

      originalFilename = filename;
      text.textContent = filename;
      input.value = filename;
      document.title = `${filename}${titleSuffix}`;
      setState('saved');
      schedule(() => setState('idle'), RENAME_SAVED_FEEDBACK_MS);
    })();
  };

  button.addEventListener('click', () => {
    if (root.dataset['renameState'] === 'saving') return;

    if (root.dataset['renameState'] === 'idle' || !root.dataset['renameState']) {
      input.value = originalFilename;
      if (failure) failure.hidden = true;
      setState('editing');
      input.focus();
      input.select();
      return;
    }
    if (root.dataset['renameState'] === 'editing') save();
  });

  input.addEventListener('keydown', (event) => {
    if (root.dataset['renameState'] === 'saving') {
      event.preventDefault();
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  });
}

function wireDelete(root: HTMLElement, fetchImpl: typeof fetch): void {
  const confirmButton = find<HTMLButtonElement>(root, '[data-delete-yes]');
  if (!confirmButton) return;

  const failure = find<HTMLElement>(root, '[data-delete-failed]');
  const shortId = root.dataset['shortId'] ?? '';

  find<HTMLButtonElement>(root, '[data-delete-trigger]')?.addEventListener('click', () => {
    root.dataset['confirming'] = 'true';
    if (failure) failure.hidden = true;
  });

  find<HTMLButtonElement>(root, '[data-delete-cancel]')?.addEventListener('click', () => {
    delete root.dataset['confirming'];
  });

  confirmButton.addEventListener('click', () => {
    void (async () => {
      confirmButton.disabled = true;

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

      if (ok) {
        root.dataset['previewState'] = 'deleted';
        return;
      }

      confirmButton.disabled = false;
      delete root.dataset['confirming'];
      if (failure) failure.hidden = false;
    })();
  });
}

/** `[data-preview]` に配線する。所有者向けの要素が無ければコピーだけを有効にする。 */
export function mountPreviewActions(
  root: HTMLElement,
  options: PreviewActionsOptions = {}
): void {
  const fetchImpl = options.fetchImpl ?? fetch;
  const schedule: Schedule =
    options.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const reload = options.reload ?? (() => window.location.reload());

  wireCopy(root, schedule);
  const shortId = root.dataset['shortId'] ?? '';
  const input = find<HTMLInputElement>(root, '[data-preview-url]');
  if (consumeAutoCopy(shortId, options.storage) && input) {
    void copyToClipboard(input.value, input).then((copied) => {
      // コピーは即時（離脱で取りこぼさないため）。表示だけ遅らせて、ボタンが変わる瞬間を見せる。
      if (copied) schedule(() => showCopied(root, schedule), AUTO_COPY_FEEDBACK_DELAY_MS);
    });
  }
  wirePin(root, fetchImpl, reload);
  wireRename(root, fetchImpl, schedule);
  wireDelete(root, fetchImpl);
}
