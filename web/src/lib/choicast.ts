import type { Locale } from '../i18n';

/**
 * 姉妹サービス「ちょいキャス」（画面共有・ライブ配信）の入口。
 *
 * 画面共有は 2026-09-07 にちょいキャスへ分離した。WebScreen 側の旧 URL
 * （/screen-share/ とその別名）はここへ 301 し、LP・フッターからも誘導する。
 */
// ちょいキャスの正規ホストは apex。app.choicast.com は apex へ 301 するだけなので、
// そちらへ向けると旧 URL からの転送が二段になり、被リンクの評価が目減りする。
const CHOICAST_ORIGIN = 'https://choicast.com';

/** ロケール付きのちょいキャス URL（例: https://choicast.com/ja/ ）。 */
export function choicastUrl(lang: Locale): string {
  return `${CHOICAST_ORIGIN}/${lang}/`;
}
