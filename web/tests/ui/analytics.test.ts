import { describe, expect, test } from 'bun:test';

import {
  ANALYTICS_EVENT_NAMES,
  analyticsPageConfig,
  containsPublicId,
  dispatchAnalyticsEvent,
  pageContext,
  type AnalyticsEventName,
  type AnalyticsEventParameterMap,
  type AnalyticsGtag,
} from '../../src/lib/ui/analytics';

const PARAMETERS: AnalyticsEventParameterMap['convert_complete'] = {
  tool: 'convert',
  source: 'home',
  input_kind: 'image',
  locale: 'ja',
};

describe('GA4 製品イベント契約', () => {
  test('page locationと同一origin referrerからquery/hashを除く', () => {
    expect(analyticsPageConfig(
      { origin: 'https://web-screen.net', pathname: '/ja/screen-share/' },
      'https://web-screen.net/ja/?stream-id=Secret123456#live'
    )).toEqual({
      page_location: 'https://web-screen.net/ja/screen-share/',
      page_referrer: 'https://web-screen.net/ja/',
    });
  });

  test('外部・不正referrerはGA4へ渡さない', () => {
    const page = { origin: 'https://web-screen.net', pathname: '/en/' };
    expect(analyticsPageConfig(page, 'https://example.com/private?q=secret')?.page_referrer).toBe('');
    expect(analyticsPageConfig(page, 'not a url')?.page_referrer).toBe('');
  });

  test('公開IDを含む同一origin referrerは空文字で上書きする', () => {
    // 省略すると gtag が document.referrer を自動収集し、公開 URL がそのまま Google へ渡る。
    const page = { origin: 'https://web-screen.net', pathname: '/ja/' };
    expect(analyticsPageConfig(page, 'https://web-screen.net/Ab12Cd34Ef56/')).toEqual({
      page_location: 'https://web-screen.net/ja/',
      page_referrer: '',
    });
    expect(
      analyticsPageConfig(page, 'https://web-screen.net/ja/screen-share/')?.page_referrer
    ).toBe('https://web-screen.net/ja/screen-share/');
  });

  test('公開IDを含む現在パスでは初期設定自体を送らない', () => {
    expect(analyticsPageConfig(
      { origin: 'https://web-screen.net', pathname: '/Ab12Cd34Ef56/' },
      ''
    )).toBeNull();
  });

  test.each([
    ['/ja/', false],
    ['/ja/screen-share/', false],
    ['/en/video-player/', false],
    ['/Ab12Cd34Ef56/', true],
    ['/ja/Ab12Cd34Ef56', true],
  ])('%s の公開ID判定は %s', (pathname, expected) => {
    expect(containsPublicId(pathname)).toBe(expected);
  });

  test('イベント固有でないパラメータは型として受け付けない', () => {
    if (false) {
      dispatchAnalyticsEvent(
        { hostname: 'web-screen.net' },
        'screen_share_ready',
        {
          tool: 'screen_share', source: 'screen_share_page', locale: 'ja',
          // @ts-expect-error screen_share 系へ input_kind は送れない。
          input_kind: 'image',
        }
      );
      // @ts-expect-error convert 系は input_kind が必須。
      dispatchAnalyticsEvent({ hostname: 'web-screen.net' }, 'convert_complete', {
        tool: 'convert', source: 'home', locale: 'ja',
      });
    }
    expect(true).toBe(true);
  });

  test('許可する9イベントを固定する', () => {
    expect(ANALYTICS_EVENT_NAMES).toEqual([
      'screen_share_start',
      'screen_share_ready',
      'screen_share_url_copy',
      'convert_start',
      'convert_complete',
      'convert_url_copy',
      'tool_nav_click',
      'resume_prompt_impression',
      'resume_prompt_click',
    ]);
  });

  test.each(['localhost', 'preview.web-screen.net', 'webscreen.pages.dev'])(
    '本番ホスト完全一致でない %s には送らない',
    (hostname) => {
      const calls: unknown[][] = [];
      dispatchAnalyticsEvent(
        { hostname, gtag: ((...args: unknown[]) => calls.push(args)) as AnalyticsGtag },
        'convert_complete',
        PARAMETERS
      );

      expect(calls).toEqual([]);
    }
  );

  test('本番ホストへは許可パラメータだけをそのまま送る', () => {
    const calls: [string, AnalyticsEventName, AnalyticsEventParameterMap[AnalyticsEventName]][] = [];
    const gtag = ((
      command: string,
      event: AnalyticsEventName,
      parameters: AnalyticsEventParameterMap[AnalyticsEventName]
    ) => calls.push([command, event, parameters])) as unknown as AnalyticsGtag;

    dispatchAnalyticsEvent({ hostname: 'web-screen.net', gtag }, 'convert_complete', PARAMETERS);

    expect(calls).toEqual([['event', 'convert_complete', PARAMETERS]]);
  });

  test('型を迂回した余分なキーやイベント不一致の値も実行時に拒否する', () => {
    const calls: unknown[][] = [];
    const environment = {
      hostname: 'web-screen.net',
      gtag: ((...args: unknown[]) => calls.push(args)) as AnalyticsGtag,
    };
    const unsafeDispatch = dispatchAnalyticsEvent as unknown as (
      target: typeof environment,
      event: string,
      parameters: object
    ) => void;

    unsafeDispatch(environment, 'screen_share_ready', {
      tool: 'screen_share', source: 'screen_share_page', locale: 'ja', input_kind: 'image',
    });
    unsafeDispatch(environment, 'screen_share_secret', {
      tool: 'screen_share', source: 'screen_share_page', locale: 'ja',
    });

    expect(calls).toEqual([]);
  });

  test('イベント名とパラメータ以外の引数を持つ呼び出しを拒否する', () => {
    const calls: unknown[][] = [];
    const environment = {
      hostname: 'web-screen.net',
      gtag: ((...args: unknown[]) => calls.push(args)) as AnalyticsGtag,
    };
    const unsafeDispatch = dispatchAnalyticsEvent as unknown as (
      target: typeof environment,
      ...eventCall: unknown[]
    ) => void;

    unsafeDispatch(environment, 'convert_complete', PARAMETERS, { send_to: 'G-OTHER' });
    unsafeDispatch(environment, 'convert_complete');

    expect(calls).toEqual([]);
  });

  test('送信するパラメータは検証済みフィールドから組み直す', () => {
    const calls: unknown[][] = [];
    const environment = {
      hostname: 'web-screen.net',
      gtag: ((...args: unknown[]) => calls.push(args)) as AnalyticsGtag,
    };

    dispatchAnalyticsEvent(environment, 'convert_complete', PARAMETERS);

    expect(calls[0][2]).toEqual(PARAMETERS);
    // 呼び出し元のオブジェクトをそのまま渡すと、後から生えたキーが GA4 へ素通りする。
    expect(calls[0][2]).not.toBe(PARAMETERS);
  });

  test('gtag不在・例外でも呼び出し元へ例外を返さない', () => {
    expect(() => dispatchAnalyticsEvent(
      { hostname: 'web-screen.net' },
      'screen_share_ready',
      { tool: 'screen_share', source: 'screen_share_page', locale: 'en' }
    )).not.toThrow();
    expect(() => dispatchAnalyticsEvent(
      { hostname: 'web-screen.net', gtag: (() => { throw new Error('blocked'); }) as AnalyticsGtag },
      'screen_share_ready',
      { tool: 'screen_share', source: 'screen_share_page', locale: 'en' }
    )).not.toThrow();
  });

  test('現在パスをhome・専用ページだけへ変換し、他パスは拒否する', () => {
    expect(pageContext('/ja/', 'convert')).toEqual({ source: 'home', locale: 'ja' });
    expect(pageContext('/en/screen-share/', 'screen_share')).toEqual({
      source: 'screen_share_page',
      locale: 'en',
    });
    expect(pageContext('/ja/convert/', 'convert')).toEqual({ source: 'convert_page', locale: 'ja' });
    expect(pageContext('/ja/preview/', 'convert')).toBeNull();
    expect(pageContext('/fr/', 'convert')).toBeNull();
  });
});
