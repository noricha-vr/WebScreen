import { isShortId } from '../contracts/r2key';

/** GA4 へ送信できるイベント名。未実装 UI のイベントも契約としてここで予約する。 */
export const ANALYTICS_EVENT_NAMES = [
  'convert_start',
  'convert_complete',
  'convert_error',
  'convert_url_copy',
  'tool_nav_click',
  'resume_prompt_impression',
  'resume_prompt_click',
  'login_click',
] as const;

/**
 * convert_error の reason。表示側の UploadErrorCode（lib/ui/upload-flow.ts）と同じ語彙。
 * エラー本文や URL は載せず、分類だけを送る。
 */
export const ANALYTICS_ERROR_REASONS = [
  'tooLarge',
  'unsupported',
  'tooManyPages',
  'pageTooLong',
  'captureTimeout',
  'sessionExpired',
  'failed',
  'pdfUrlNotSupported',
  'imageUrlNotSupported',
  'videoUrlNotSupported',
  'nonWebPageUrl',
  'wasmLoadTimeout',
  'imageFetchTimeout',
  'uploadTimeout',
  'apiTimeout',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];
export type AnalyticsErrorReason = (typeof ANALYTICS_ERROR_REASONS)[number];
export type AnalyticsTool = 'convert';
export type AnalyticsSource = 'home' | 'convert_page' | 'header' | 'resume';
export type AnalyticsInputKind = 'web' | 'image' | 'pdf';
export type AnalyticsLocale = 'ja' | 'en';

export interface AnalyticsConfigParameters {
  page_location: string;
  page_referrer: string;
}

export type ConversionAnalyticsEvent = Extract<
  AnalyticsEventName,
  'convert_start' | 'convert_complete' | 'convert_error' | 'convert_url_copy'
>;

export interface ConversionParameters {
  tool: 'convert';
  source: 'home' | 'convert_page';
  input_kind: AnalyticsInputKind;
  locale: AnalyticsLocale;
}

/** 失敗は分類（reason）だけを添える。URL・ファイル名・例外本文は送らない。 */
export interface ConversionErrorParameters extends ConversionParameters {
  reason: AnalyticsErrorReason;
}

interface ToolNavigationParameters {
  tool: AnalyticsTool;
  source: 'header';
  locale: AnalyticsLocale;
}

/** ヘッダーのログイン導線。どのページからでも押せるので source で区別する。 */
interface LoginClickParameters {
  tool: AnalyticsTool;
  source: 'header';
  locale: AnalyticsLocale;
}

interface ResumeParameters {
  tool: AnalyticsTool;
  source: 'resume';
  locale: AnalyticsLocale;
}

/** イベントごとに送信を許可するパラメータ。余分なキーを受ける汎用 Record は公開しない。 */
export interface AnalyticsEventParameterMap {
  convert_start: ConversionParameters;
  convert_complete: ConversionParameters;
  convert_error: ConversionErrorParameters;
  convert_url_copy: ConversionParameters;
  tool_nav_click: ToolNavigationParameters;
  resume_prompt_impression: ResumeParameters;
  resume_prompt_click: ResumeParameters;
  login_click: LoginClickParameters;
}

export type AnalyticsEventCall = {
  [Event in AnalyticsEventName]: [event: Event, parameters: AnalyticsEventParameterMap[Event]];
}[AnalyticsEventName];

export interface AnalyticsGtag {
  (command: 'event', ...eventCall: AnalyticsEventCall): void;
  (command: 'js', initializedAt: Date): void;
  (command: 'config', measurementId: string, parameters: AnalyticsConfigParameters): void;
}

export interface AnalyticsEnvironment {
  hostname: string;
  gtag?: AnalyticsGtag;
}

const TRACKED_HOST = 'web-screen.net';

/**
 * 公開 ID（変換の shortId。12 文字 base62）をパスに含むか。
 *
 * 公開 URL は 12 文字のランダム ID だけで守られているため、GA4 へ渡すと保護が Google 側へ漏れる。
 */
export function containsPublicId(pathname: string): boolean {
  return pathname.split('/').some(isShortId);
}

/**
 * GA4 へ渡す referrer。
 *
 * - 外部: origin だけ（例 `https://www.google.com/`）。流入元の判定には host があれば足り、
 *   パスと query には外部ページ側の任意の文字列（たまたま 12 文字の ID を含むものも）が入る。
 * - 同一 origin: 公開 ID を含まないパスだけ。含むなら空文字。
 * - 空・不正: 空文字。
 *
 * Android アプリ経由の流入は `android-app://パッケージ名/` の形で届くので、http(s) 以外も
 * host があれば同じ形（scheme + host）で残す。
 */
function analyticsReferrer(rawReferrer: string, pageOrigin: string): string {
  let referrer: URL;
  try {
    referrer = new URL(rawReferrer);
  } catch {
    return '';
  }
  if (referrer.origin === pageOrigin) {
    return containsPublicId(referrer.pathname) ? '' : referrer.origin + referrer.pathname;
  }
  return referrer.host === '' ? '' : `${referrer.protocol}//${referrer.host}/`;
}

/**
 * query/hash と公開 ID を除いたページ情報だけを GA4 初期設定へ渡す。
 *
 * page_location の query は utm_* も含めて全部落とす。キャンペーン判定は効かなくなるが、
 * utm の値はリンクを作った人が自由に書けるので、公開 ID や公開 URL をそのまま入れられる。
 * 値を検証して残すほどキャンペーン計測に頼っていないため、漏らさない側に倒している。
 *
 * 公開 ID を含む現在パスでは null を返し、config 自体を送らせない。パラメータの省略は使えない
 * （gtag は page_location / page_referrer 未指定時に location.href / document.referrer を
 * 自動収集するため、省略するとフル URL が渡って逆効果になる）。referrer 側は同じ理由で
 * 送らない時も空文字を明示して自動収集を打ち消す。
 *
 * BaseLayout.astro のインラインスクリプトが同じ規則の写しを持つ。e2e/analytics.spec.ts が
 * 実際の dataLayer の値でこの関数と同じ結果になることを確かめている。
 */
export function analyticsPageConfig(
  page: { origin: string; pathname: string },
  rawReferrer: string
): AnalyticsConfigParameters | null {
  if (containsPublicId(page.pathname)) return null;
  return {
    page_location: page.origin + page.pathname,
    page_referrer: analyticsReferrer(rawReferrer, page.origin),
  };
}

/** 完全一致した本番ホストだけへ、型付きイベントを安全に送る。 */
export function dispatchAnalyticsEvent(
  environment: AnalyticsEnvironment,
  ...eventCall: AnalyticsEventCall
): void {
  if (environment.hostname !== TRACKED_HOST || !environment.gtag) return;
  const allowed = allowedEventCall(eventCall);
  if (!allowed) return;
  try {
    environment.gtag('event', ...allowed);
  } catch {
    // 計測は補助機能。広告ブロッカーや gtag 障害で製品の操作を失敗させない。
  }
}

/** 現在の変換ページに対するイベントを送る。convert_error は reason（失敗の分類）を添える。 */
export function trackConversionEvent(
  event: ConversionAnalyticsEvent,
  inputKind: AnalyticsInputKind,
  reason?: AnalyticsErrorReason
): void {
  const browser = browserEnvironment('convert');
  if (!browser) return;
  const parameters: ConversionParameters = {
    tool: 'convert',
    source: browser.source,
    input_kind: inputKind,
    locale: browser.locale,
  };
  const eventCall = (
    event === 'convert_error' ? [event, { ...parameters, reason: reason ?? 'failed' }] : [event, parameters]
  ) as unknown as AnalyticsEventCall;
  dispatchAnalyticsEvent(browser.environment, ...eventCall);
}

/** ヘッダーのログインボタンが押されたことを送る。言語付きページならどこからでも送る。 */
export function trackLoginClick(): void {
  if (typeof window === 'undefined') return;
  try {
    const locale = localeForPath(window.location.pathname);
    if (!locale) return;
    dispatchAnalyticsEvent(
      { hostname: window.location.hostname, gtag: window.gtag },
      'login_click',
      { tool: 'convert', source: 'header', locale }
    );
  } catch {
    // 計測の失敗でログイン遷移を止めない。
  }
}

/**
 * `data-analytics-login` を持つリンクの click で login_click を送る。
 *
 * 遷移は止めない（gtag は既定で sendBeacon を使うので、離脱してもイベントは届く）。
 */
export function bindLoginClickTracking(root: ParentNode): void {
  for (const link of root.querySelectorAll<HTMLElement>('[data-analytics-login]')) {
    link.addEventListener('click', () => trackLoginClick());
  }
}

/** 言語付きページ（/{lang}/ 配下すべて）の locale。言語の無いパス（共有 URL 等）は計測しない。 */
export function localeForPath(pathname: string): AnalyticsLocale | null {
  const match = pathname.match(/^\/(ja|en)(?:\/|$)/);
  return match ? (match[1] as AnalyticsLocale) : null;
}

/** 言語付き製品ページだけを、許可済み source / locale へ変換する。 */
export function pageContext(
  pathname: string,
  tool: AnalyticsTool
): { source: AnalyticsSource; locale: AnalyticsLocale } | null {
  const match = pathname.match(/^\/(ja|en)(?:\/|$)/);
  if (!match) return null;
  const locale = match[1] as AnalyticsLocale;
  if (pathname === `/${locale}` || pathname === `/${locale}/`) return { source: 'home', locale };
  if (tool === 'convert' && pathname === `/${locale}/convert/`) {
    return { source: 'convert_page', locale };
  }
  return null;
}

function browserEnvironment(tool: AnalyticsTool): {
  environment: AnalyticsEnvironment;
  source: 'home' | 'convert_page';
  locale: AnalyticsLocale;
} | null {
  if (typeof window === 'undefined') return null;
  try {
    const context = pageContext(window.location.pathname, tool);
    if (!context || context.source === 'header' || context.source === 'resume') return null;
    return {
      environment: { hostname: window.location.hostname, gtag: window.gtag },
      source: context.source,
      locale: context.locale,
    };
  } catch {
    return null;
  }
}

/**
 * 実行時に許可できる呼び出しだけを、検証済みフィールドから組み直して返す。
 *
 * 受け取ったオブジェクトをそのまま gtag へ渡さない。型を迂回した呼び出し元
 * （trackConversionEvent 等の as 経由や、将来の JS からの呼び出し）で余分なキーが
 * 付いていても、ここを通った値には現れないようにする。
 */
function allowedEventCall(eventCall: AnalyticsEventCall): AnalyticsEventCall | null {
  // 型上は常に2要素だが、実行時は rest 引数なので第3引数以降が届きうる。
  if (eventCall.length !== 2) return null;
  const [event, parameters] = eventCall;
  if (!parameters || typeof parameters !== 'object') return null;
  if (!(ANALYTICS_EVENT_NAMES as readonly string[]).includes(event)) return null;
  const locale = parameters.locale;
  if (!['ja', 'en'].includes(locale)) return null;
  const keys = Object.keys(parameters).sort().join(',');
  const { tool, source } = parameters as { tool: string; source: string };
  // 組み直した値はイベントごとの許可組み合わせを満たすが、この関数の中では
  // 判定とイベント名の対応を型で表せないため、返す時だけ契約型へ寄せる。
  const call = (value: object): AnalyticsEventCall => [event, value] as unknown as AnalyticsEventCall;

  if (event.startsWith('convert_')) {
    const inputKind = (parameters as ConversionParameters).input_kind;
    if (tool !== 'convert' || !['home', 'convert_page'].includes(source)) return null;
    if (!['web', 'image', 'pdf'].includes(inputKind)) return null;
    if (event === 'convert_error') {
      const reason = (parameters as ConversionErrorParameters).reason;
      if (!(ANALYTICS_ERROR_REASONS as readonly string[]).includes(reason)) return null;
      return keys === 'input_kind,locale,reason,source,tool'
        ? call({ tool, source, input_kind: inputKind, locale, reason })
        : null;
    }
    return keys === 'input_kind,locale,source,tool'
      ? call({ tool, source, input_kind: inputKind, locale })
      : null;
  }
  if (tool !== 'convert' || keys !== 'locale,source,tool') return null;
  if (event === 'tool_nav_click' || event === 'login_click') {
    return source === 'header' ? call({ tool, source, locale }) : null;
  }
  if (event === 'resume_prompt_impression' || event === 'resume_prompt_click') {
    return source === 'resume' ? call({ tool, source, locale }) : null;
  }
  return null;
}

declare global {
  interface Window {
    gtag?: AnalyticsGtag;
  }
}
