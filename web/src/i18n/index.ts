/**
 * 画面文言の辞書と、ロケールに関する純粋な導出関数。
 *
 * 文言の正本は ja.json / en.json のみ。テンプレート（.astro）・クライアント JS の
 * どちらからも辞書経由で参照し、日本語 / 英語をコードに直書きしない。
 * en.json は Dictionary（= ja.json の型）として読むため、キー欠落は tsc で落ちる。
 */

import ja from './ja.json';
import en from './en.json';

export const LOCALES = ['ja', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/** 既定ロケール。astro.config.mjs の i18n.defaultLocale と一致させること。 */
export const DEFAULT_LOCALE: Locale = 'ja';

/** 辞書の形は ja.json が正本。en.json は同じ形であることを型で強制する。 */
export type Dictionary = typeof ja;

const DICTIONARIES: Readonly<Record<Locale, Dictionary>> = { ja, en };

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function useTranslations(locale: Locale): Dictionary {
  return DICTIONARIES[locale];
}

/** 言語切替リンクの遷移先ロケール（2 言語なので相手側を返すだけ）。 */
export function alternateLocale(locale: Locale): Locale {
  return locale === 'ja' ? 'en' : 'ja';
}

/**
 * `/ja/privacy/` → `/en/privacy/` のように先頭のロケールセグメントだけを差し替える。
 * ロケール配下でないパスは、そのロケールのトップに落とす（想定外の URL で 404 を増やさない）。
 */
export function switchLocalePath(pathname: string, target: Locale): string {
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length === 0 || !isLocale(segments[0]!)) return `/${target}/`;

  segments[0] = target;
  return `/${segments.join('/')}/`;
}

/**
 * Accept-Language ヘッダーからロケールを決める（`/` のリダイレクト先判定）。
 *
 * q 値順に見て最初に一致した言語を採用する。未知の言語しか無い場合は既定ロケール。
 */
export function resolveLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;

  const candidates = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const quality = params
        .map((param) => param.trim())
        .find((param) => param.startsWith('q='));
      const parsed = quality ? Number.parseFloat(quality.slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), quality: Number.isNaN(parsed) ? 0 : parsed };
    })
    .filter((candidate) => candidate.tag.length > 0 && candidate.quality > 0)
    .sort((a, b) => b.quality - a.quality);

  for (const candidate of candidates) {
    const primary = candidate.tag.split('-')[0]!;
    if (isLocale(primary)) return primary;
  }

  return DEFAULT_LOCALE;
}
