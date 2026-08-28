/**
 * ダウンロード時の Content-Disposition ヘッダーを組み立てる。
 *
 * ファイル名は利用者が変更できる（rename）ため、ヘッダーへ素通しすると
 * 改行や引用符でヘッダーを分割・偽装される。ASCII の安全な代替名を quoted-string に、
 * 元の名前を RFC 5987 の `filename*` に入れ、非対応のクライアントでも壊れないようにする。
 */
export function attachmentDisposition(filename: string): string {
  const fallback = asciiFallback(filename);
  const encoded = encodeRFC5987(filename);

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * quoted-string に入れられる ASCII 名へ落とす。
 *
 * 制御文字・非 ASCII・quoted-string を壊す文字（" と \）を除いたうえで、
 * すべて失われた場合は固定名にする（空の filename= は解釈が実装依存になる）。
 */
function asciiFallback(filename: string): string {
  // eslint-disable-next-line no-control-regex -- 制御文字の除去そのものが目的
  const sanitized = filename.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '');
  return sanitized.trim() === '' ? 'movie.mp4' : sanitized;
}

/** RFC 5987 の ext-value。attr-char 以外をすべてパーセントエンコードする。 */
function encodeRFC5987(filename: string): string {
  return encodeURIComponent(filename)
    .replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%(7C|60|5E)/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
