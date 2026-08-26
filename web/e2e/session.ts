import type { BrowserContext } from '@playwright/test';

import {
  createSessionPayload,
  importSigningKey,
  signSession,
  SESSION_COOKIE_NAME,
} from '../src/lib/contracts/session';
import { E2E_SESSION_SIGNING_KEY } from '../playwright.config';

/**
 * 本人のセッション Cookie を作る（Worker と同じ鍵・同じ署名形式）。
 *
 * `*.spec.ts` に置くと testMatch に拾われてテストが二重登録されるため、
 * 共有ヘルパーは spec ではないファイル名にしている。
 */
export async function signIn(context: BrowserContext, userId: number): Promise<void> {
  const key = await importSigningKey(E2E_SESSION_SIGNING_KEY);
  const value = await signSession(createSessionPayload(userId), key);

  await context.addCookies([{ name: SESSION_COOKIE_NAME, value, domain: 'localhost', path: '/' }]);
}
