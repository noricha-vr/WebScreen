import { describe, expect, it } from 'bun:test';

import { attachmentDisposition } from '../../src/lib/services/download';

describe('attachmentDisposition', () => {
  it('ASCII のファイル名はそのまま quoted-string に入る', () => {
    expect(attachmentDisposition('slides.mp4')).toBe(
      `attachment; filename="slides.mp4"; filename*=UTF-8''slides.mp4`
    );
  });

  it('日本語のファイル名は filename* 側へエンコードして渡す', () => {
    const header = attachmentDisposition('発表資料.mp4');

    // 非 ASCII は quoted-string から落ち、拡張子だけが残る
    expect(header).toContain('filename=".mp4"');
    expect(header).toContain(`filename*=UTF-8''${encodeURIComponent('発表資料')}.mp4`);
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
