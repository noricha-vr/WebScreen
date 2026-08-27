const AUTO_COPY_KEY = 'webscreen:auto-copy';

/**
 * 自動コピーの完了表示を遅らせる時間。
 *
 * 遷移直後に「コピーしました」まで出すとボタンが最初からその状態で描画され、
 * 自動で押されたことに気づけない。遅らせるのは表示だけで、コピー自体は即時に行う
 * （離脱でコピーを取りこぼしたり、直後の貼り付けが古い内容になったりするため）。
 */
export const AUTO_COPY_FEEDBACK_DELAY_MS = 500;

export type SessionStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

/** 次に開く同じプレビューで動画 URL をコピーする one-shot フラグを保存する。 */
export function markAutoCopy(shortId: string, storage?: SessionStorage): void {
  try {
    // sessionStorage 自体が無い環境でも落ちないよう、参照を try の中に置く。
    (storage ?? sessionStorage).setItem(AUTO_COPY_KEY, shortId);
  } catch {
    // ストレージが無効でも、変換完了後のプレビュー遷移は妨げない。
  }
}

/** このプレビューへの one-shot 自動コピー要求を消費し、一致時だけ true を返す。 */
export function consumeAutoCopy(shortId: string, storage?: SessionStorage): boolean {
  try {
    // sessionStorage 自体が無い環境でも落ちないよう、参照を try の中に置く。
    const store = storage ?? sessionStorage;
    const markedShortId = store.getItem(AUTO_COPY_KEY);
    store.removeItem(AUTO_COPY_KEY);
    return markedShortId === shortId;
  } catch {
    return false;
  }
}
