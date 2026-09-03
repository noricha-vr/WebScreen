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

/** query/hashを除いたページ情報だけをGA4初期設定へ渡す。 */
export function analyticsPageConfig(
  page: { origin: string; pathname: string },
  rawReferrer: string
): AnalyticsConfigParameters {
  let pageReferrer = '';
  try {
    const referrer = new URL(rawReferrer);
    if (referrer.origin === page.origin) pageReferrer = referrer.origin + referrer.pathname;
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
  if (!isAllowedEventCall(eventCall)) return;
  try {
    environment.gtag('event', ...eventCall);
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

function isAllowedEventCall(eventCall: AnalyticsEventCall): boolean {
  const [event, parameters] = eventCall;
  if (!parameters || typeof parameters !== 'object') return false;
  if (!(ANALYTICS_EVENT_NAMES as readonly string[]).includes(event)) return false;
  if (!['ja', 'en'].includes(parameters.locale)) return false;
  const keys = Object.keys(parameters).sort().join(',');
  if (event.startsWith('screen_share_')) {
    return parameters.tool === 'screen_share' &&
      ['home', 'screen_share_page'].includes(parameters.source) && keys === 'locale,source,tool';
  }
  if (event.startsWith('convert_')) {
    const value = parameters as ConversionParameters;
    return value.tool === 'convert' && ['home', 'convert_page'].includes(value.source) &&
      ['web', 'image', 'pdf'].includes(value.input_kind) && keys === 'input_kind,locale,source,tool';
  }
  const allowedTool = ['screen_share', 'convert'].includes(parameters.tool);
  if (event === 'tool_nav_click') {
    return allowedTool && parameters.source === 'header' && keys === 'locale,source,tool';
  }
  if (event === 'resume_prompt_impression' || event === 'resume_prompt_click') {
    return allowedTool && parameters.source === 'resume' && keys === 'locale,source,tool';
  }
  return false;
}

declare global {
  interface Window {
    gtag?: AnalyticsGtag;
  }
}
