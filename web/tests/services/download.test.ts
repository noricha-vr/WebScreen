import { describe, expect, it } from 'bun:test';

import {
  attachmentDisposition,
  downloadFilename,
  downloadHeaders,
  partialContentRange,
  rangeApplies,
  resolveRangeRequest,
  unsatisfiedContentRange,
} from '../../src/lib/services/download';

describe('attachmentDisposition', () => {
  it('ASCII のファイル名はそのまま quoted-string に入る', () => {
    expect(attachmentDisposition('slides.mp4')).toBe(
      `attachment; filename="slides.mp4"; filename*=UTF-8''slides.mp4`
    );
  });

  it('日本語のファイル名は filename* 側へエンコードして渡す', () => {
    const header = attachmentDisposition('発表資料.mp4');

    // 非 ASCII が落ちると拡張子だけになるので、quoted-string は既定名にする
    expect(header).toContain('filename="movie.mp4"');
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('発表資料')}.mp4`);
  });

  it('対になっていないサロゲートでもヘッダーを組み立てられる', () => {
    // encodeURIComponent は例外を投げるため、既定名へ落として応答自体は返す
    expect(() => attachmentDisposition('\uD800.mp4')).not.toThrow();
  });

  it('引用符とバックスラッシュを quoted-string から除く', () => {
    // これらを素通しすると filename の終端を偽装できる
    const header = attachmentDisposition('a"b\\c.mp4');

    expect(header).toContain('filename="abc.mp4"');
    expect(header).not.toContain('a"b');
  });

  it('改行を含むファイル名でヘッダーを分割できない', () => {
    // 残った文字列は quoted-string の内側に収まるためヘッダーとしては解釈されない。
    // 防ぎたいのは改行そのもの（filename の値は api.ts の isSafeFilename でも弾かれる）。
    const header = attachmentDisposition('evil.mp4\r\nSet-Cookie: session=1');

    expect(header).not.toContain('\r');
    expect(header).not.toContain('\n');
    expect(header.split('"')).toHaveLength(3); // quoted-string が1つだけ = 終端を偽装できていない
  });

  it('ASCII が残らないファイル名では既定の名前へ落とす', () => {
    // filename= を空にすると解釈が実装依存になるため、必ず何かを入れる
    expect(attachmentDisposition('動画')).toContain('filename="movie.mp4"');
  });
});

describe('downloadFilename', () => {
  it('実体は必ず mp4 なので拡張子を .mp4 へ正規化する', () => {
    // 表示名は rename API で自由に変えられる。video/mp4 を .pdf や .exe として
    // 配布できると、受け取った側が中身と違う扱いをする
    expect(downloadFilename('slides.pdf')).toBe('slides.mp4');
    expect(downloadFilename('payload.exe')).toBe('payload.mp4');
    expect(downloadFilename('clip.mp4')).toBe('clip.mp4');
  });

  it('拡張子が無ければ .mp4 を付ける', () => {
    expect(downloadFilename('recording')).toBe('recording.mp4');
  });

  it('拡張子しかない名前は既定名にする', () => {
    expect(downloadFilename('.mp4')).toBe('movie.mp4');
  });
});

describe('resolveRangeRequest', () => {
  const SIZE = 1000;

  it('Range が無ければ全体を返す', () => {
    expect(resolveRangeRequest(null, SIZE)).toEqual({ kind: 'full' });
  });

  it('開始と終了を指定した範囲をそのまま解決する', () => {
    expect(resolveRangeRequest('bytes=0-99', SIZE)).toEqual({
      kind: 'partial',
      offset: 0,
      length: 100,
    });
  });

  it('終了を省いた範囲は末尾までにする', () => {
    expect(resolveRangeRequest('bytes=900-', SIZE)).toEqual({
      kind: 'partial',
      offset: 900,
      length: 100,
    });
  });

  it('実体より後ろまで要求されても末尾で止める', () => {
    // R2 側でも切り詰められるが、Content-Range は実際に返す長さと一致させる必要がある
    expect(resolveRangeRequest('bytes=900-9999', SIZE)).toEqual({
      kind: 'partial',
      offset: 900,
      length: 100,
    });
  });

  it('suffix は末尾からの長さとして解決する', () => {
    expect(resolveRangeRequest('bytes=-100', SIZE)).toEqual({
      kind: 'partial',
      offset: 900,
      length: 100,
    });
  });

  it('総量より大きい suffix は全体になる', () => {
    expect(resolveRangeRequest('bytes=-5000', SIZE)).toEqual({
      kind: 'partial',
      offset: 0,
      length: SIZE,
    });
  });

  it('開始位置が総量以上なら満たせない', () => {
    // R2 は開始位置が総量を超えた時の挙動を規定していないため、渡す前に弾く
    expect(resolveRangeRequest('bytes=1000-1099', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('終了が開始より小さい範囲は満たせない', () => {
    expect(resolveRangeRequest('bytes=500-100', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('0 バイトの suffix は満たせない', () => {
    expect(resolveRangeRequest('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('数値として壊れている範囲は満たせない', () => {
    expect(resolveRangeRequest('bytes=abc', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRangeRequest('bytes=-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(resolveRangeRequest('bytes=', SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('桁あふれする開始位置は満たせない', () => {
    // Number 化で精度が落ちた値を R2 へ渡すと、意図しない位置から読み出される
    expect(resolveRangeRequest('bytes=99999999999999999999-', SIZE)).toEqual({
      kind: 'unsatisfiable',
    });
  });

  it('未知の単位は無視して全体を返す', () => {
    // RFC 9110 14.2 が無視を求めている。416 は満たせる要求への誤答になる
    expect(resolveRangeRequest('items=0-5', SIZE)).toEqual({ kind: 'full' });
  });

  it('複数レンジは未対応なので全体を返す', () => {
    expect(resolveRangeRequest('bytes=0-99,200-299', SIZE)).toEqual({ kind: 'full' });
  });
});

describe('partialContentRange', () => {
  it('末尾の位置を範囲に含めて組み立てる', () => {
    expect(partialContentRange({ offset: 0, length: 100 }, 1000)).toBe('bytes 0-99/1000');
    expect(partialContentRange({ offset: 900, length: 100 }, 1000)).toBe('bytes 900-999/1000');
  });
});

describe('unsatisfiedContentRange', () => {
  it('満たせる範囲が無いことと総量を伝える', () => {
    expect(unsatisfiedContentRange(1000)).toBe('bytes */1000');
  });
});

describe('rangeApplies', () => {
  const ETAG = '"abc123"';

  it('If-Range が無ければ範囲をそのまま使う', () => {
    expect(rangeApplies(null, ETAG)).toBe(true);
  });

  it('実体の validator と一致すれば範囲を使う', () => {
    expect(rangeApplies(ETAG, ETAG)).toBe(true);
  });

  it('一致しなければ範囲を使わない', () => {
    // 続きのつもりで別の実体を継ぎ足すと、壊れたファイルが出来上がる
    expect(rangeApplies('"stale"', ETAG)).toBe(false);
  });

  it('弱い validator は一致扱いにしない', () => {
    // strong comparison が要る（RFC 9110 13.1.5）
    expect(rangeApplies(`W/${ETAG}`, ETAG)).toBe(false);
  });

  it('日付形式の If-Range も一致扱いにしない', () => {
    // Last-Modified を返していないので、日付は比較の根拠にならない
    expect(rangeApplies('Wed, 21 Oct 2026 07:28:00 GMT', ETAG)).toBe(false);
  });
});

describe('downloadHeaders', () => {
  it('部分取得でも保存名と noindex を落とさない', () => {
    // 再開したダウンロードだけ別扱いになると、保存名やインデックス制御が抜ける
    const headers = downloadHeaders({
      filename: 'slides.pdf',
      contentLength: 100,
      etag: '"abc123"',
      contentRange: 'bytes 0-99/1000',
    });

    expect(headers['Content-Range']).toBe('bytes 0-99/1000');
    expect(headers['Content-Length']).toBe('100');
    expect(headers['Accept-Ranges']).toBe('bytes');
    expect(headers['ETag']).toBe('"abc123"');
    expect(headers['Content-Disposition']).toContain('filename="slides.mp4"');
    expect(headers['X-Robots-Tag']).toBe('noindex');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('全体を返すときは Content-Range を付けない', () => {
    const headers = downloadHeaders({
      filename: 'slides.pdf',
      contentLength: 1000,
      etag: '"abc123"',
    });

    expect(headers['Content-Range']).toBeUndefined();
    expect(headers['Content-Length']).toBe('1000');
    expect(headers['Accept-Ranges']).toBe('bytes');
    expect(headers['ETag']).toBe('"abc123"');
  });
});
