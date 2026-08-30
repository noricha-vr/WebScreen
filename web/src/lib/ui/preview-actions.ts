/**
 * プレビューページ（/{shortId}/）の DOM 配線。
 *
 * URL コピーは全員に、pin と削除は所有者だけに出す（HTML 自体をサーバー側で出し分ける）。
 * 文言は HTML に埋め込まれた辞書の値を読むだけで、ここに日本語 / 英語を書かない。
 */

import { MAX_FILENAME_LENGTH } from '../contracts/api';
import { copyToClipboard } from './clipboard';
import { AUTO_COPY_FEEDBACK_DELAY_MS, consumeAutoCopy, type SessionStorage } from './auto-copy';
import { reportRequestFailure } from './client-error-report';
import { movieEndpoint, pinEndpoint } from './history-view';
import { isUnauthorizedRequestError, JsonRequestError, requestJson } from './request-json';

// 遷移直後の自動コピーでも見逃しにくい長さ（2000ms は短すぎるとの報告で延長）
const COPIED_FEEDBACK_MS = 4000;
const RENAME_SAVED_FEEDBACK_MS = 2000;

type Schedule = (callback: () => void, delayMs: number) => void;

/** Escape を拾うためだけの document。テストから差し替えられるよう最小限に絞る。 */
interface DocumentEventTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
}

export interface PreviewActionsOptions {
  fetchImpl?: typeof fetch;
  schedule?: Schedule;
  /** pin 成功後の再読み込み。保管期限の表示はサーバーが持つので画面を作り直す。 */
  reload?: () => void;
  /** 自動コピー要求の保存先（既定は sessionStorage）。 */
  storage?: SessionStorage;
  /** ツールチップを閉じる Escape の取得先（既定は document）。 */
  document?: DocumentEventTarget;
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

function requestFailureMessage(root: HTMLElement, error: unknown, fallback: string): string {
  return isUnauthorizedRequestError(error) ? (root.dataset['msgSessionExpired'] ?? fallback) : fallback;
}

/** pin の失敗理由を文言に落とす。理由ごとに次の行動が変わるので status で分ける。 */
function pinFailureMessage(root: HTMLElement, error: unknown): string {
  if (error instanceof JsonRequestError) {
    if (error.status === 409) return root.dataset['msgPinLimit'] ?? '';
    if (error.status === 410) return root.dataset['msgPinExpired'] ?? '';
  }
  return requestFailureMessage(root, error, root.dataset['msgPinFailed'] ?? '');
}

/**
 * ホバー / フォーカスで出る補足を Escape で閉じられるようにする（WCAG 1.4.13 Dismissible）。
 *
 * ポインタでホバーしている間はフォーカスが別の場所にあるため、キー入力は document で拾う。
 * 閉じたことを示すフラグは、その要素から離れた時に外す（次のホバーでまた出す）。
 */
function wireTooltips(root: HTMLElement, doc: DocumentEventTarget): void {
  const scopes = [...root.querySelectorAll<HTMLElement>('[data-tooltip-scope]')];
  if (scopes.length === 0) return;

  doc.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Escape') return;
    for (const scope of scopes) scope.dataset['tooltipDismissed'] = 'true';
  });

  for (const scope of scopes) {
    const restore = (): void => {
      delete scope.dataset['tooltipDismissed'];
    };
    scope.addEventListener('mouseleave', restore);
    scope.addEventListener('focusout', restore);
  }
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

      let error: unknown;
      try {
        await requestJson(pinEndpoint(shortId), {
          method: 'POST',
          credentials: 'same-origin',
        }, fetchImpl);
        reload();
        return;
      } catch (requestError) {
        error = requestError;
        reportRequestFailure('pin', requestError);
      }

      button.disabled = false;
      if (!failure) return;
      // 409 は「上限に達した」、410 は「保管期限を過ぎた」。それ以外は汎用の失敗
      failure.textContent = pinFailureMessage(root, error);
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

      let error: unknown;
      try {
        await requestJson(movieEndpoint(shortId), {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filename }),
        }, fetchImpl);
      } catch (requestError) {
        error = requestError;
        reportRequestFailure('rename', requestError);
      }

      button.disabled = false;
      if (error !== undefined) {
        if (failure) {
          failure.textContent = requestFailureMessage(root, error, root.dataset['msgRenameFailed'] ?? '');
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

      if (error === undefined) {
        root.dataset['previewState'] = 'deleted';
        return;
      }

      confirmButton.disabled = false;
      delete root.dataset['confirming'];
      if (failure) {
        failure.textContent = requestFailureMessage(root, error, root.dataset['msgDeleteFailed'] ?? '');
        failure.hidden = false;
      }
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
  wireTooltips(root, options.document ?? document);
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
