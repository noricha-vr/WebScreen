import type { APIRoute } from 'astro';

import { DEFAULT_LOCALE, isLocale } from '../../../i18n';
import { SESSION_COOKIE_NAME } from '../../../lib/contracts/session';

export const prerender = false;

/**
 * ログインセッション Cookie を破棄し、元いた言語のトップへ戻す。
 *
 * ヘッダーの form 送信から呼ばれるため、204 ではなくリダイレクトを返す
 * （204 だとブラウザが遷移せず、画面上はログアウトが効かないように見える）。
 * 303 なのは POST の再送を避けて GET で遷移させるため。
 */
export const POST: APIRoute = async ({ cookies, redirect, request }) => {
  cookies.delete(SESSION_COOKIE_NAME, { path: '/' });

  // lang は外部入力なので辞書にあるロケールだけを通す（オープンリダイレクト防止）。
  const form = await request.formData().catch(() => null);
  const requested = form?.get('lang');
  const lang = typeof requested === 'string' && isLocale(requested) ? requested : DEFAULT_LOCALE;

  return redirect(`/${lang}/`, 303);
};
