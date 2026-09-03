/** 画面共有プレビューの表示設定を読む・保存する境界。 */
export interface PreviewPreferenceStore {
  load(): boolean | null;
  save(open: boolean): void;
}

/** 画面共有プレビュー表示設定の localStorage キー。 */
export const SCREEN_SHARE_PREVIEW_PREFERENCE_KEY = 'webscreen:screen-share:preview-open';

/** ブラウザの localStorage にプレビュー表示設定を保存する。 */
export const browserPreviewPreference: PreviewPreferenceStore = {
  load(): boolean | null {
    try {
      const value = window.localStorage.getItem(SCREEN_SHARE_PREVIEW_PREFERENCE_KEY);
      return value === 'true' ? true : value === 'false' ? false : null;
    } catch {
      return null;
    }
  },
  save(open: boolean): void {
    try {
      window.localStorage.setItem(SCREEN_SHARE_PREVIEW_PREFERENCE_KEY, String(open));
    } catch (error) {
      console.warn('Failed to save screen share preview preference', error);
    }
  },
};
