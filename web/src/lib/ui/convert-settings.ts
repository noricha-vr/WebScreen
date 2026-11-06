import {
  DEFAULT_SECONDS_PER_FRAME,
  isSecondsPerFrame,
  SECONDS_PER_FRAME_OPTIONS,
  type SecondsPerFrame,
} from '../convert/settings';

const STORAGE_KEY = 'webscreen:seconds-per-frame';
type SettingsStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** ストレージ参照自体が拒否される場合も既定値で続ける。 */
export function loadSecondsPerFrame(storage?: SettingsStorage): SecondsPerFrame {
  try {
    const value = (storage ?? window.localStorage).getItem(STORAGE_KEY);
    return SECONDS_PER_FRAME_OPTIONS.find((seconds) => String(seconds) === value)
      ?? DEFAULT_SECONDS_PER_FRAME;
  } catch {
    return DEFAULT_SECONDS_PER_FRAME;
  }
}

export function saveSecondsPerFrame(seconds: SecondsPerFrame, storage?: SettingsStorage): void {
  try {
    (storage ?? window.localStorage).setItem(STORAGE_KEY, String(seconds));
  } catch {
    // 保存が使えなくても、この画面で選んだ値で変換できる。
  }
}

/** 設定の表示と保存を配線し、変換開始時に値を固定できる getter を返す。 */
export function mountConvertSettings(panel: HTMLElement): () => SecondsPerFrame {
  let seconds = loadSecondsPerFrame();
  const radios = panel.querySelectorAll<HTMLInputElement>('[data-seconds-per-frame]');
  const summary = panel.querySelector<HTMLElement>('[data-settings-summary]');
  const example = panel.querySelector<HTMLElement>('[data-settings-example-seconds]');
  const render = (): void => {
    for (const radio of radios) radio.checked = radio.value === String(seconds);
    if (summary) {
      summary.textContent = (summary.dataset['template'] ?? '').replace('{seconds}', String(seconds));
    }
    if (example) example.textContent = String(12 * seconds);
  };
  for (const radio of radios) {
    radio.addEventListener('change', () => {
      const value = Number(radio.value);
      if (!radio.checked || !isSecondsPerFrame(value)) return;
      seconds = value;
      saveSecondsPerFrame(seconds);
      render();
    });
  }
  render();
  return () => seconds;
}
