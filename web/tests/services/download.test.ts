import { describe, expect, it } from 'bun:test';

import { attachmentDisposition, downloadFilename } from '../../src/lib/services/download';

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
