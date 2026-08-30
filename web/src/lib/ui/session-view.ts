/**
 * `GET /api/me/` の結果で画面をログイン前 / ログイン後に切り替える。
 *
 * ページは静的生成（output: 'static'）でセッション Cookie を読めないため、
 * 各状態の HTML を含めておき、ここで `data-auth-state` を切り替えて出し分ける。
 * 既定値は guest なので、JS が動かない環境でもログイン導線だけは表示される。
 */

import { parseViewer, viewerInitial, type Viewer } from './viewer';

/** trailingSlash: 'always' のためスラッシュ必須。省くと 301 を挟む。 */
export const ME_ENDPOINT = '/api/me/';

export type AuthState = 'guest' | 'member' | 'error';

export function applyViewer(root: HTMLElement, viewer: Viewer): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-viewer-name]')) {
    if (viewer.name !== null) element.textContent = viewer.name;
  }

  // アバター画像が無いときの代替表示なので、画像を出すときは頭文字を下げる
  for (const element of root.querySelectorAll<HTMLElement>('[data-viewer-initial]')) {
    element.textContent = viewerInitial(viewer);
    element.hidden = viewer.avatarUrl !== null;
  }

  for (const image of root.querySelectorAll<HTMLImageElement>('[data-viewer-avatar]')) {
    if (viewer.avatarUrl === null) continue;
    image.src = viewer.avatarUrl;
    image.hidden = false;
  }
}

/**
 * 失敗の告知。role="alert" は CSS の display 切り替えでは読み上げられないので、
 * hidden を外して文言を差し込む（辞書の値は data-* で HTML から受け取る）。
 */
function announceAuthFailure(root: HTMLElement): void {
  for (const element of root.querySelectorAll<HTMLElement>('[data-session-error]')) {
    const target = element.querySelector<HTMLElement>('[data-session-error-message]');
    if (target) target.textContent = element.dataset['msgSessionUnavailable'] ?? '';
    element.hidden = false;
  }
}

/**
 * 認証基盤の異常。guest と分けて `error` に倒し、画面と console の両方に残す。
 *
 * guest へ倒すと、ログイン済みのユーザーが黙ってログアウトしたように見えるだけで
 * 誰も障害に気づけない。ログイン導線は残すが、状態が不明なことは必ず知らせる。
 */
function failAuthState(root: HTMLElement, reason: string): 'error' {
  // 理由は種別だけ（例外の message / stack は個人情報や URL を含みうる）。
  console.error(`session_state_unresolved: ${reason}`);
  root.dataset['authState'] = 'error';
  announceAuthFailure(root);
  return 'error';
}

/**
 * ログイン状態を解決して `data-auth-state` に反映する。
 *
 * 未ログインと言い切れるのは 401 だけ。通信失敗と 401 以外の失敗応答は
 * 認証基盤の異常なので error に倒す。
 */
export async function resolveAuthState(
  root: HTMLElement,
  fetchImpl: typeof fetch = fetch
): Promise<AuthState> {
  let response: Response;
  try {
    response = await fetchImpl(ME_ENDPOINT, { credentials: 'same-origin' });
  } catch (error) {
    return failAuthState(root, error instanceof Error ? error.name : 'UnknownError');
  }

  if (response.status === 401) {
    root.dataset['authState'] = 'guest';
    return 'guest';
  }

  if (!response.ok) {
    return failAuthState(root, `status ${response.status}`);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // payload が読めなくてもログイン済みの扱いは変えない（表示名だけ既定値になる）
  }

  applyViewer(root, parseViewer(payload));
  root.dataset['authState'] = 'member';
  return 'member';
}
