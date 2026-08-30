import { afterEach, describe, expect, test } from 'bun:test';

import { mountHistoryMenu } from '../../src/lib/ui/history-menu';

type Listener = (event: Event) => void;

/** 行のひな型から複製される 1 行。fillRow / wireDelete は空の querySelector で足りる。 */
class FakeRow {
  readonly dataset: Record<string, string> = {};

  querySelector(): unknown {
    return null;
  }
}

class FakeList {
  readonly rows: unknown[] = [];

  replaceChildren(): void {
    this.rows.length = 0;
  }

  append(row: unknown): void {
    this.rows.push(row);
  }

  get children(): { length: number } {
    return { length: this.rows.length };
  }
}

class FakeHistoryMenu {
  readonly dataset: Record<string, string> = {
    historyState: 'idle',
    msgHistoryFailed: 'history failed',
    msgSessionExpired: 'session expired',
  };
  readonly errorMessage = { textContent: '' };
  readonly list = new FakeList();
  open = true;
  private readonly listeners = new Map<string, Listener>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, listener);
  }

  querySelector(selector: string): unknown {
    if (selector === '[data-history-error-message]') return this.errorMessage;
    if (selector === '[data-history-list]') return this.list;
    if (selector === '[data-history-item]') {
      return { content: { cloneNode: () => ({ querySelector: () => new FakeRow() }) } };
    }
    return null;
  }

  dispatch(type: string): void {
    this.listeners.get(type)?.(new Event(type));
  }
}

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalConsoleError = console.error;
const errors: unknown[][] = [];

afterEach(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
  console.error = originalConsoleError;
});

/** 履歴メニューを開いた直後の状態を返す。 */
async function openMenu(respond: () => Response): Promise<FakeHistoryMenu> {
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { addEventListener: () => {} },
  });
  errors.length = 0;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };

  const menu = new FakeHistoryMenu();
  mountHistoryMenu(
    menu as unknown as HTMLDetailsElement,
    (async () => respond()) as unknown as typeof fetch
  );

  menu.dispatch('toggle');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return menu;
}

function movie(overrides: Record<string, unknown> = {}) {
  return {
    shortId: 'AbCdEf123456',
    filename: 'slides.pdf',
    status: 'ready',
    pinned: false,
    createdAt: '2026-08-25T11:00:00.000Z',
    expiresAt: '2026-09-24T11:00:00.000Z',
    publicUrl: 'https://public.example/movies/AbCdEf123456.mp4',
    ...overrides,
  };
}

describe('履歴の取得失敗', () => {
  test('401 はセッション切れの文言を表示する', async () => {
    const menu = await openMenu(() => Response.json({ errorCode: 'UNAUTHORIZED' }, { status: 401 }));

    expect(menu.dataset['historyState']).toBe('error');
    expect(menu.errorMessage.textContent).toBe('session expired');
  });

  test('読めない行が 1 件でもあれば、残りを出さずエラーにする', async () => {
    const menu = await openMenu(() =>
      Response.json({ movies: [movie(), movie({ status: 'unknown' })] })
    );

    expect(menu.dataset['historyState']).toBe('error');
    expect(menu.errorMessage.textContent).toBe('history failed');
    expect(menu.list.rows).toHaveLength(0);
    expect(errors).toEqual([['history_entries_dropped: 1']]);
  });
});

describe('履歴の取得成功', () => {
  test('全件読めれば一覧を表示する', async () => {
    const menu = await openMenu(() => Response.json({ movies: [movie(), movie()] }));

    expect(menu.dataset['historyState']).toBe('ready');
    expect(menu.list.rows).toHaveLength(2);
    expect(errors).toHaveLength(0);
  });

  test('0 件はエラーではなく空として表示する', async () => {
    const menu = await openMenu(() => Response.json({ movies: [] }));

    expect(menu.dataset['historyState']).toBe('empty');
    expect(errors).toHaveLength(0);
  });
});
