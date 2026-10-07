import { describe, expect, test } from 'bun:test';

import {
  ANALYTICS_EVENT_NAMES,
  analyticsPageConfig,
  containsPublicId,
  dispatchAnalyticsEvent,
  localeForPath,
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
      { origin: 'https://web-screen.net', pathname: '/ja/web/' },
      'https://web-screen.net/ja/?short-id=Secret123456#done'
    )).toEqual({
      page_location: 'https://web-screen.net/ja/web/',
      page_referrer: 'https://web-screen.net/ja/',
    });
  });

  test.each([
    // 検索エンジン: query（検索語）とパスは落とし、流入元の判定に要る origin だけ残す。
    ['https://www.google.com/search?q=x', 'https://www.google.com/'],
    ['https://www.bing.com/search?q=vrchat+pdf', 'https://www.bing.com/'],
    // 外部ページのパスに 12 文字の ID が入っていても origin しか送らない。
    ['https://example.com/Ab12Cd34Ef56/?q=secret#frag', 'https://example.com/'],
    ['http://example.com:8080/a/b', 'http://example.com:8080/'],
    // ホスト名のラベルに 12 文字の英数字があれば、小文字化されていても ID の漏れとして送らない。
    ['https://Ab12Cd34Ef56.example.com/', ''],
    ['https://www.ab12cd34ef56.example/x', ''],
    // Android アプリからの流入は scheme + host の形で届く。
    ['android-app://com.google.android.gm/', 'android-app://com.google.android.gm/'],
    // 空・不正・host の無い referrer は送らない（空文字で自動収集を打ち消す）。
    ['', ''],
    ['not a url', ''],
    ['about:blank', ''],
  ])('外部referrer %s はoriginだけ送る', (raw, expected) => {
    const page = { origin: 'https://web-screen.net', pathname: '/en/' };
    expect(analyticsPageConfig(page, raw)?.page_referrer).toBe(expected);
  });

  test('page locationはutmを含むqueryを全部落とす', () => {
    // utm の値には公開 ID や公開 URL を自由に入れられるため、キャンペーン用でも残さない。
    expect(analyticsPageConfig(
      { origin: 'https://web-screen.net', pathname: '/ja/web/' },
      ''
    )?.page_location).toBe('https://web-screen.net/ja/web/');
  });

  test('公開IDを含む同一origin referrerは空文字で上書きする', () => {
    // 省略すると gtag が document.referrer を自動収集し、公開 URL がそのまま Google へ渡る。
    const page = { origin: 'https://web-screen.net', pathname: '/ja/' };
    expect(analyticsPageConfig(page, 'https://web-screen.net/Ab12Cd34Ef56/')).toEqual({
      page_location: 'https://web-screen.net/ja/',
      page_referrer: '',
    });
    expect(
      analyticsPageConfig(page, 'https://web-screen.net/ja/web/')?.page_referrer
    ).toBe('https://web-screen.net/ja/web/');
  });

  test('公開IDを含む現在パスでは初期設定自体を送らない', () => {
    expect(analyticsPageConfig(
      { origin: 'https://web-screen.net', pathname: '/Ab12Cd34Ef56/' },
      ''
    )).toBeNull();
  });

  test.each([
    ['/ja/', false],
    ['/ja/web/', false],
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
        'tool_nav_click',
        {
          tool: 'convert', source: 'header', locale: 'ja',
          // @ts-expect-error tool_nav_click へ input_kind は送れない。
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

  test('許可するイベントを固定する', () => {
    expect(ANALYTICS_EVENT_NAMES).toEqual([
      'convert_start',
      'convert_complete',
      'convert_error',
      'convert_url_copy',
      'tool_nav_click',
      'resume_prompt_impression',
      'resume_prompt_click',
      'login_click',
    ]);
  });

  test('convert_error は allowlist の reason だけを添えて送り、それ以外は落とす', () => {
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

    dispatchAnalyticsEvent(environment, 'convert_error', { ...PARAMETERS, reason: 'tooLarge' });
    // URL や例外本文を reason に載せる呼び出しは、型を迂回しても通さない。
    unsafeDispatch(environment, 'convert_error', { ...PARAMETERS, reason: 'https://example.com/secret' });
    unsafeDispatch(environment, 'convert_error', PARAMETERS);
    unsafeDispatch(environment, 'convert_complete', { ...PARAMETERS, reason: 'failed' });

    expect(calls).toEqual([['event', 'convert_error', { ...PARAMETERS, reason: 'tooLarge' }]]);
  });

  test('login_click は header からだけ送る', () => {
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

    dispatchAnalyticsEvent(environment, 'login_click', { tool: 'convert', source: 'header', locale: 'en' });
    unsafeDispatch(environment, 'login_click', { tool: 'convert', source: 'home', locale: 'en' });

    expect(calls).toEqual([['event', 'login_click', { tool: 'convert', source: 'header', locale: 'en' }]]);
  });

  test.each([
    ['/ja/', 'ja'],
    ['/en/web/', 'en'],
    ['/ja/pdf', 'ja'],
    ['/', null],
    ['/Ab12Cd34Ef56/', null],
  ])('%s の言語判定は %s', (pathname, expected) => {
    expect(localeForPath(pathname)).toBe(expected as 'ja' | 'en' | null);
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

    unsafeDispatch(environment, 'tool_nav_click', {
      tool: 'convert', source: 'header', locale: 'ja', input_kind: 'image',
    });
    unsafeDispatch(environment, 'convert_secret', {
      tool: 'convert', source: 'home', locale: 'ja', input_kind: 'image',
    });
    // 削除した画面共有のイベント名・tool 値は実行時にも通さない。
    unsafeDispatch(environment, 'screen_share_ready', {
      tool: 'screen_share', source: 'screen_share_page', locale: 'ja',
    });
    unsafeDispatch(environment, 'tool_nav_click', {
      tool: 'screen_share', source: 'header', locale: 'ja',
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
      'tool_nav_click',
      { tool: 'convert', source: 'header', locale: 'en' }
    )).not.toThrow();
    expect(() => dispatchAnalyticsEvent(
      { hostname: 'web-screen.net', gtag: (() => { throw new Error('blocked'); }) as AnalyticsGtag },
      'tool_nav_click',
      { tool: 'convert', source: 'header', locale: 'en' }
    )).not.toThrow();
  });

  test('現在パスをhome・専用ページだけへ変換し、他パスは拒否する', () => {
    expect(pageContext('/ja/', 'convert')).toEqual({ source: 'home', locale: 'ja' });
    expect(pageContext('/en/screen-share/', 'convert')).toBeNull();
    expect(pageContext('/ja/convert/', 'convert')).toEqual({ source: 'convert_page', locale: 'ja' });
    expect(pageContext('/ja/preview/', 'convert')).toBeNull();
    expect(pageContext('/fr/', 'convert')).toBeNull();
  });
});
