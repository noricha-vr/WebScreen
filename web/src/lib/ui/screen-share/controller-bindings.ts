import type { ScreenShareView } from './view';

export interface ScreenShareActions {
  start(stopOthers: boolean): void;
  copyUrl(): void;
  copyDiagnostics(): void;
  record(): void;
  extend(): void;
  stop(): void;
  retry(): void;
  pageHide(): void;
}

/** 画面共有 UI の DOM イベントを controller 操作へ結線する。 */
export function bindScreenShareActions(
  view: ScreenShareView,
  onPageHide: (handler: () => void) => void,
  actions: ScreenShareActions
): void {
  view.onClick('[data-screen-start]', () => actions.start(false));
  view.onClick('[data-screen-copy]', actions.copyUrl);
  view.onClick('[data-screen-copy-diagnostics]', actions.copyDiagnostics);
  view.onClick('[data-screen-record]', actions.record);
  view.onClick('[data-screen-extend]', actions.extend);
  view.onClick('[data-screen-stop]', actions.stop);
  view.onClick('[data-screen-retry]', actions.retry);
  view.onClick('[data-screen-stop-others]', () => actions.start(true));
  view.onClick('[data-screen-preview-toggle]', () => view.togglePreview());
  onPageHide(actions.pageHide);
}
