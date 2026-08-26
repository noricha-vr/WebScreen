/**
 * アップロードする mp4 のファイル名を決める純粋関数。
 *
 * 変換結果はダウンロード名・履歴の表示名としてそのまま残るため、
 * 「元が何だったか」が分かる名前を作るのがここの責務。DOM には触らない。
 *
 * 生成した名前は presign の filename としてサーバーへ送られ、
 * contracts/api.ts の isSafeFilename で検証される。パス区切り・制御文字を
 * 含めないこと、長すぎないことはこちら側で保証する。
 */

/** 拡張子込みの上限。UI・ダウンロード名として読める長さに抑える（サーバー上限 255 より厳しい）。 */
const MAX_NAME_LENGTH = 80;

const MP4_EXTENSION = '.mp4';

/** URL から名前を作れなかったときの名前（従来の固定値と同じ）。 */
const FALLBACK_NAME = `capture${MP4_EXTENSION}`;

/** `index.html` のような「そのディレクトリを指すだけ」のセグメント。名前に使っても情報がない。 */
const INDEX_SEGMENT = /^index\.[^.]+$/i;

/** 制御文字の境界。isSafeFilename が弾く範囲と合わせる。 */
const CONTROL_CHAR_MAX = 0x1f;
const DELETE_CHAR = 0x7f;

/** 拡張子を落とす。先頭ドット（`.gitignore` 等）は拡張子ではなく名前として残す。 */
function baseName(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** isSafeFilename が弾く文字（パス区切りと制御文字）かどうか。 */
function isUnsafeChar(char: string): boolean {
  if (char === '/' || char === '\\') return true;
  const code = char.codePointAt(0) ?? 0;
  return code <= CONTROL_CHAR_MAX || code === DELETE_CHAR;
}

function sanitize(value: string): string {
  return [...value].map((char) => (isUnsafeChar(char) ? '-' : char)).join('');
}

/** コードポイント単位で切る（slice はサロゲートペアを割って壊れた文字を残す）。 */
function truncate(value: string, limit: number): string {
  const chars = [...value];
  return chars.length <= limit ? value : chars.slice(0, limit).join('');
}

/**
 * ファイル選択・ドロップから作る名前。
 *
 * 1 件なら元のファイル名の拡張子を mp4 に替えるだけ。複数件は先頭ファイル名に
 * 残り件数を添える（`batchSuffixTemplate` の `{count}` を先頭以外の件数で置換）。
 */
export function movieNameForFiles(names: readonly string[], batchSuffixTemplate: string): string {
  const first = names[0];
  if (first === undefined) return FALLBACK_NAME;

  const base = baseName(first);
  if (names.length === 1) return `${base}${MP4_EXTENSION}`;

  const suffix = batchSuffixTemplate.replaceAll('{count}', String(names.length - 1));
  return `${base} ${suffix}${MP4_EXTENSION}`;
}

/**
 * URL 変換から作る名前。`{ホスト名}-{末尾の意味のあるパスセグメント}.mp4` にする。
 *
 * 例: https://zenn.dev/noricha/articles/abc123 → `zenn.dev-abc123.mp4`
 * パスが実質無ければホスト名だけ、URL として読めなければ `capture.mp4`。
 */
export function movieNameForUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return FALLBACK_NAME;
  }
  if (url.hostname.length === 0) return FALLBACK_NAME;

  const segment = meaningfulSegment(url.pathname);
  const base = segment === null ? url.hostname : `${url.hostname}-${segment}`;

  // decode で `%2F` が `/` に戻りうるため、sanitize は decode の後でなければならない。
  return `${truncate(sanitize(base), MAX_NAME_LENGTH - MP4_EXTENSION.length)}${MP4_EXTENSION}`;
}

/** 末尾から遡って、名前に使える最初のセグメントを返す（無ければ null）。 */
function meaningfulSegment(pathname: string): string | null {
  const segments = pathname.split('/').filter((segment) => segment.length > 0);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    if (INDEX_SEGMENT.test(segment)) continue;
    return decodeSegment(segment);
  }
  return null;
}

/** パーセントエンコードを戻して読める名前にする（不正なエンコードはそのまま使う）。 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
