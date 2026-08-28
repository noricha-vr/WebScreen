/** 保存名の既定。表示名から ASCII の手がかりが何も残らなかった時に使う。 */
const DEFAULT_DOWNLOAD_NAME = 'movie.mp4';

/**
 * 保存に使うファイル名を決める。
 *
 * 表示名は rename API で自由に変えられ、拡張子も制限していない。実体は必ず mp4 なので、
 * `.pdf` や `.exe` のような拡張子のまま配布させないよう保存名は `.mp4` に正規化する。
 */
export function downloadFilename(filename: string): string {
  const base = filename.replace(/\.[^./\\]*$/, '').trim();
  return base === '' ? DEFAULT_DOWNLOAD_NAME : `${base}.mp4`;
}

/**
 * ダウンロード時の Content-Disposition ヘッダーを組み立てる。
 *
 * ファイル名は利用者が変更できるため、ヘッダーへ素通しすると改行や引用符で
 * ヘッダーを分割・偽装される。ASCII の安全な代替名を quoted-string に、
 * 元の名前を RFC 5987 の `filename*` に入れ、非対応のクライアントでも壊れないようにする。
 */
export function attachmentDisposition(filename: string): string {
  const normalized = downloadFilename(filename);
  const fallback = asciiFallback(normalized);
  const encoded = encodeRFC5987(normalized);

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * quoted-string に入れられる ASCII 名へ落とす。
 *
 * 制御文字・非 ASCII・quoted-string を壊す文字（" と \）を除く。拡張子しか残らない
 * 場合も既定名にする（`.mp4` だけだと Unix 系で隠しファイル扱いになる）。
 */
function asciiFallback(filename: string): string {
  const sanitized = filename.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '');
  const base = sanitized.replace(/\.[^./\\]*$/, '').trim();
  return base === '' ? DEFAULT_DOWNLOAD_NAME : sanitized;
}

/**
 * RFC 5987 の ext-value。attr-char 以外をすべてパーセントエンコードする。
 *
 * 対になっていないサロゲートを含む名前は encodeURIComponent が例外を投げるため、
 * その場合は既定名へ落とす（ヘッダー生成の失敗でダウンロード全体を落とさない）。
 */
function encodeRFC5987(filename: string): string {
  let encoded: string;
  try {
    encoded = encodeURIComponent(filename);
  } catch {
    encoded = DEFAULT_DOWNLOAD_NAME;
  }

  return encoded.replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
