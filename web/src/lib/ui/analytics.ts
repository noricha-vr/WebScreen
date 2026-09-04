import { isShortId } from '../contracts/r2key';

/** GA4 へ送信できるイベント名。未実装 UI のイベントも契約としてここで予約する。 */
export const ANALYTICS_EVENT_NAMES = [
  'screen_share_start',
  'screen_share_ready',
  'screen_share_url_copy',
  'convert_start',
  'convert_complete',
  'convert_url_copy',
  'tool_nav_click',
  'resume_prompt_impression',
  'resume_prompt_click',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];
export type AnalyticsTool = 'screen_share' | 'convert';
export type AnalyticsSource = 'home' | 'screen_share_page' | 'convert_page' | 'header' | 'resume';
export type AnalyticsInputKind = 'web' | 'image' | 'pdf';
export type AnalyticsLocale = 'ja' | 'en';

export interface AnalyticsConfigParameters {
  page_location: string;
  page_referrer: string;
}

export type ScreenShareAnalyticsEvent = Extract<
  AnalyticsEventName,
  'screen_share_start' | 'screen_share_ready' | 'screen_share_url_copy'
>;
export type ConversionAnalyticsEvent = Extract<
  AnalyticsEventName,
  'convert_start' | 'convert_complete' | 'convert_url_copy'
>;

interface ScreenShareParameters {
  tool: 'screen_share';
  source: 'home' | 'screen_share_page';
  locale: AnalyticsLocale;
}

export interface ConversionParameters {
  tool: 'convert';
  source: 'home' | 'convert_page';
  input_kind: AnalyticsInputKind;
  locale: AnalyticsLocale;
}

interface ToolNavigationParameters {
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
  screen_share_start: ScreenShareParameters;
  screen_share_ready: ScreenShareParameters;
  screen_share_url_copy: ScreenShareParameters;
  convert_start: ConversionParameters;
  convert_complete: ConversionParameters;
  convert_url_copy: ConversionParameters;
  tool_nav_click: ToolNavigationParameters;
  resume_prompt_impression: ResumeParameters;
  resume_prompt_click: ResumeParameters;
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
 * 公開 ID（変換の shortId・配信 ID。どちらも 12 文字 base62）をパスに含むか。
 *
 * 公開 URL は 12 文字のランダム ID だけで守られているため、GA4 へ渡すと保護が Google 側へ漏れる。
 */
export function containsPublicId(pathname: string): boolean {
  return pathname.split('/').some(isShortId);
}

/**
 * query/hash と公開 ID を除いたページ情報だけを GA4 初期設定へ渡す。
 *
 * 公開 ID を含む現在パスでは null を返し、config 自体を送らせない。パラメータの省略は使えない
 * （gtag は page_location / page_referrer 未指定時に location.href / document.referrer を
 * 自動収集するため、省略するとフル URL が渡って逆効果になる）。referrer 側は同じ理由で
 * 空文字を明示的に送って自動収集を打ち消す。
 */
export function analyticsPageConfig(
  page: { origin: string; pathname: string },
  rawReferrer: string
): AnalyticsConfigParameters | null {
  if (containsPublicId(page.pathname)) return null;
  let pageReferrer = '';
  try {
    const referrer = new URL(rawReferrer);
    if (referrer.origin === page.origin && !containsPublicId(referrer.pathname)) {
      pageReferrer = referrer.origin + referrer.pathname;
    }
  } catch {
    // 空・不正・外部 referrer は送らない。
  }
  return { page_location: page.origin + page.pathname, page_referrer: pageReferrer };
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

/** 現在の画面共有ページに対する成功イベントを送る。 */
export function trackScreenShareEvent(event: ScreenShareAnalyticsEvent): void {
  const browser = browserEnvironment('screen_share');
  if (!browser || browser.source === 'convert_page') return;
  const eventCall = [event, {
    tool: 'screen_share',
    source: browser.source,
    locale: browser.locale,
  }] as unknown as AnalyticsEventCall;
  dispatchAnalyticsEvent(browser.environment, ...eventCall);
}

/** 現在の変換ページに対する成功イベントを送る。 */
export function trackConversionEvent(
  event: ConversionAnalyticsEvent,
  inputKind: AnalyticsInputKind
): void {
  const browser = browserEnvironment('convert');
  if (!browser || browser.source === 'screen_share_page') return;
  const eventCall = [event, {
    tool: 'convert',
    source: browser.source,
    input_kind: inputKind,
    locale: browser.locale,
  }] as unknown as AnalyticsEventCall;
  dispatchAnalyticsEvent(browser.environment, ...eventCall);
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
  if (tool === 'screen_share' && pathname === `/${locale}/screen-share/`) {
    return { source: 'screen_share_page', locale };
  }
  if (tool === 'convert' && pathname === `/${locale}/convert/`) {
    return { source: 'convert_page', locale };
  }
  return null;
}

function browserEnvironment(tool: AnalyticsTool): {
  environment: AnalyticsEnvironment;
  source: 'home' | 'screen_share_page' | 'convert_page';
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
 * （trackScreenShareEvent 等の as 経由や、将来の JS からの呼び出し）で余分なキーが
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

  if (event.startsWith('screen_share_')) {
    if (tool !== 'screen_share' || !['home', 'screen_share_page'].includes(source)) return null;
    return keys === 'locale,source,tool' ? call({ tool, source, locale }) : null;
  }
  if (event.startsWith('convert_')) {
    const inputKind = (parameters as ConversionParameters).input_kind;
    if (tool !== 'convert' || !['home', 'convert_page'].includes(source)) return null;
    if (!['web', 'image', 'pdf'].includes(inputKind)) return null;
    return keys === 'input_kind,locale,source,tool'
      ? call({ tool, source, input_kind: inputKind, locale })
      : null;
  }
  if (!['screen_share', 'convert'].includes(tool) || keys !== 'locale,source,tool') return null;
  if (event === 'tool_nav_click') {
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
