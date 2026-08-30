import { afterEach, describe, expect, test } from 'bun:test';

import { resolveAuthState } from '../../src/lib/ui/session-view';

/** resolveAuthState が触るのは dataset と querySelectorAll だけ。 */
class FakeRoot {
  readonly dataset: Record<string, string> = { authState: 'guest' };

  querySelectorAll(): unknown[] {
    return [];
  }
}

function fakeRoot(): { root: HTMLElement; dataset: Record<string, string> } {
  const fake = new FakeRoot();
  return { root: fake as unknown as HTMLElement, dataset: fake.dataset };
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
    const { root, dataset } = fakeRoot();

    expect(await resolveAuthState(root, respondWith(401))).toBe('guest');
    expect(dataset['authState']).toBe('guest');
    expect(errors).toHaveLength(0);
  });

  test('200 はログイン済みとして member にする', async () => {
    const { root, dataset } = fakeRoot();

    expect(await resolveAuthState(root, respondWith(200, '{"name":"noricha"}'))).toBe('member');
    expect(dataset['authState']).toBe('member');
  });

  test('通信できないときは guest ではなくエラー表示にする', async () => {
    captureConsoleError();
    const { root, dataset } = fakeRoot();
    const failing = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;

    expect(await resolveAuthState(root, failing)).toBe('error');
    expect(dataset['authState']).toBe('error');
    expect(errors).toHaveLength(1);
  });

  test.each([[500], [502], [403]])('%p は guest ではなくエラー表示にする', async (status) => {
    captureConsoleError();
    const { root, dataset } = fakeRoot();

    expect(await resolveAuthState(root, respondWith(status))).toBe('error');
    expect(dataset['authState']).toBe('error');
    expect(errors).toHaveLength(1);
  });
});
