const AUTO_COPY_KEY = 'webscreen:auto-copy';

type SessionStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

/** 次に開く同じプレビューで動画 URL をコピーする one-shot フラグを保存する。 */
export function markAutoCopy(shortId: string, storage: SessionStorage = sessionStorage): void {
  try {
    storage.setItem(AUTO_COPY_KEY, shortId);
  } catch {
    // ストレージが無効でも、変換完了後のプレビュー遷移は妨げない。
  }
}

/** このプレビューへの one-shot 自動コピー要求を消費し、一致時だけ true を返す。 */
export function consumeAutoCopy(
  shortId: string,
  storage: SessionStorage = sessionStorage
): boolean {
  try {
    const markedShortId = storage.getItem(AUTO_COPY_KEY);
    storage.removeItem(AUTO_COPY_KEY);
    return markedShortId === shortId;
  } catch {
    return false;
  }
}
