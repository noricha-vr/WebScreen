import { afterEach, describe, expect, test } from 'bun:test';

import { mountHistoryMenu } from '../../src/lib/ui/history-menu';

type Listener = (event: Event) => void;

class FakeHistoryMenu {
  readonly dataset: Record<string, string> = {
    historyState: 'idle',
    msgHistoryFailed: 'history failed',
    msgSessionExpired: 'session expired',
  };
  readonly errorMessage = { textContent: '' };
  open = true;
  private readonly listeners = new Map<string, Listener>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  querySelector(selector: string): unknown {
    return selector === '[data-history-error-message]' ? this.errorMessage : null;
  }

  dispatch(type: string): void {
    this.listeners.get(type)?.(new Event(type));
  }
}

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

afterEach(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
});

describe('履歴の取得失敗', () => {
  test('401 はセッション切れの文言を表示する', async () => {
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: { addEventListener: () => {} },
    });
    const menu = new FakeHistoryMenu();
    mountHistoryMenu(
      menu as unknown as HTMLDetailsElement,
      (async () => Response.json({ errorCode: 'UNAUTHORIZED' }, { status: 401 })) as unknown as typeof fetch
    );

    menu.dispatch('toggle');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(menu.dataset['historyState']).toBe('error');
    expect(menu.errorMessage.textContent).toBe('session expired');
  });
});
