import { afterEach, describe, expect, test } from 'bun:test';

import { resolveAuthState } from '../../src/lib/ui/session-view';

/** ヘッダーの失敗告知（hidden を外して文言を差し込む先）。 */
class FakeAlert {
  readonly dataset: Record<string, string> = { msgSessionUnavailable: 'ログイン状態を確認できません' };
  readonly message = { textContent: '' };
  hidden = true;

  querySelector(selector: string): unknown {
    return selector === '[data-session-error-message]' ? this.message : null;
  }
}

/** resolveAuthState が触るのは dataset と querySelectorAll だけ。 */
class FakeRoot {
  readonly dataset: Record<string, string> = { authState: 'guest' };
  readonly alert = new FakeAlert();

  querySelectorAll(selector: string): unknown[] {
    return selector === '[data-session-error]' ? [this.alert] : [];
  }
}

function fakeRoot(): { root: HTMLElement; dataset: Record<string, string>; alert: FakeAlert } {
  const fake = new FakeRoot();
  return { root: fake as unknown as HTMLElement, dataset: fake.dataset, alert: fake.alert };
}

function respondWith(status: number, body = '{}'): typeof fetch {
  return (async () =>
    new Response(body, {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;
}

const originalConsoleError = console.error;
const errors: unknown[][] = [];

function captureConsoleError(): void {
  errors.length = 0;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
}

afterEach(() => {
  console.error = originalConsoleError;
});

describe('resolveAuthState', () => {
  test('401 は未ログインとして guest にする', async () => {
    captureConsoleError();
    const { root, dataset, alert } = fakeRoot();

    expect(await resolveAuthState(root, respondWith(401))).toBe('guest');
    expect(dataset['authState']).toBe('guest');
    expect(alert.hidden).toBe(true);
    expect(errors).toHaveLength(0);
  });

  test('200 はログイン済みとして member にする', async () => {
    const { root, dataset } = fakeRoot();

    expect(await resolveAuthState(root, respondWith(200, '{"name":"noricha"}'))).toBe('member');
    expect(dataset['authState']).toBe('member');
  });

  test('通信できないときは guest ではなくエラー表示にする', async () => {
    captureConsoleError();
    const { root, dataset, alert } = fakeRoot();
    const failing = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;

    expect(await resolveAuthState(root, failing)).toBe('error');
    expect(dataset['authState']).toBe('error');
    expect(alert.hidden).toBe(false);
    expect(alert.message.textContent).toBe('ログイン状態を確認できません');
  });

  test('console には例外の種別だけを出し、Error オブジェクトを渡さない', async () => {
    captureConsoleError();
    const { root } = fakeRoot();
    const failing = (() =>
      Promise.reject(new TypeError('Failed to fetch https://secret.example/'))) as unknown as typeof fetch;

    await resolveAuthState(root, failing);

    expect(errors).toEqual([['session_state_unresolved: TypeError']]);
  });

  test.each([[500], [502], [403]])('%p は guest ではなくエラー表示にする', async (status) => {
    captureConsoleError();
    const { root, dataset, alert } = fakeRoot();

    expect(await resolveAuthState(root, respondWith(status))).toBe('error');
    expect(dataset['authState']).toBe('error');
    expect(alert.hidden).toBe(false);
    expect(errors).toEqual([[`session_state_unresolved: status ${status}`]]);
  });
});
