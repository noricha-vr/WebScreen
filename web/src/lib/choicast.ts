import type { Locale } from '../i18n';

/**
 * 姉妹サービス「ちょいキャス」（画面共有・ライブ配信）の入口。
 *
 * 画面共有は 2026-09-07 にちょいキャスへ分離した。WebScreen 側の /screen-share/ は
 * cutover が終わるまで残し、LP・フッター・画面共有ページからここへ誘導する。
 */
const CHOICAST_ORIGIN = 'https://app.choicast.com';

/** ロケール付きのちょいキャス URL（例: https://app.choicast.com/ja/ ）。 */
export function choicastUrl(lang: Locale): string {
  return `${CHOICAST_ORIGIN}/${lang}/`;
}
