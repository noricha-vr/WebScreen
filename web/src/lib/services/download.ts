/** 保存名の既定。表示名から ASCII の手がかりが何も残らなかった時に使う。 */
const DEFAULT_DOWNLOAD_NAME = 'movie.mp4';

/** R2 に入る実体は常に mp4。表示名の拡張子は保存名の正規化にしか使わない。 */
const CONTENT_TYPE = 'video/mp4';

/**
 * 同じ動画への連続アクセスをエッジで吸収しつつ、削除後に配信され続ける窓は
 * 短く抑える（cdn 直の既定 TTL 120 分より大幅に短い）。
 */
const CACHE_CONTROL = 'public, max-age=300';

/** Range ヘッダーで唯一受け付ける単位。 */
const BYTES_UNIT_PREFIX = 'bytes=';

/** `bytes=<first>-<last>` の両端。片方は省略できる（両方の省略は不正）。 */
const BYTES_RANGE_SPEC = /^(\d*)-(\d*)$/;

/**
 * Range 要求を実体の総量と突き合わせた結果。
 *
 * - `full`: 範囲を無視して全体を返す（ヘッダー無し・未知の単位・複数レンジ）
 * - `partial`: 206 で返す確定した範囲
 * - `unsatisfiable`: 416 を返す（実体と重ならない・構文が壊れている）
 */
export type ResolvedRange =
  | { kind: 'full' }
  | { kind: 'partial'; offset: number; length: number }
  | { kind: 'unsatisfiable' };

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
 * ダウンロード応答のヘッダーを組み立てる。
 *
 * 200 と 206 で 1 箇所に集約するのは、再開したダウンロードだけ保存名や noindex が
 * 落ちるのを防ぐため。`Content-Length` を明示しないと本文が chunked になり、
 * 受け取り側で総量が分からず進捗表示も再開の判断もできない。
 */
export function downloadHeaders(input: {
  filename: string;
  contentLength: number;
  contentRange?: string;
}): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': CONTENT_TYPE,
    'Content-Disposition': attachmentDisposition(input.filename),
    'Content-Length': String(input.contentLength),
    // 部分取得に対応していることは、要求される前に伝える必要がある
    'Accept-Ranges': 'bytes',
    // cdn 側の Transform Rule はこの経路に効かないため、ここで明示する。
    'X-Robots-Tag': 'noindex',
    'Cache-Control': CACHE_CONTROL,
  };

  if (input.contentRange !== undefined) headers['Content-Range'] = input.contentRange;

  return headers;
}

/**
 * Range ヘッダーを実体の総量と突き合わせ、R2 へ渡せる範囲まで確定させる。
 *
 * R2 の `range` は長さの超過ぶんを切り詰めるが、開始位置が総量を超えた場合の挙動は
 * ドキュメントに規定がない。総量が分かった時点でこちら側で 416 を判断し、R2 には
 * 必ず満たせる `{offset, length}` だけを渡す（返却される `range` の形にも依存しない）。
 */
export function resolveRangeRequest(header: string | null, size: number): ResolvedRange {
  if (header === null) return { kind: 'full' };

  const value = header.trim();
  // 単位を理解できない要求は無視して全体を返す（RFC 9110 14.2）
  if (!value.toLowerCase().startsWith(BYTES_UNIT_PREFIX)) return { kind: 'full' };

  const spec = value.slice(BYTES_UNIT_PREFIX.length).trim();
  // 複数レンジは multipart/byteranges になるため未対応。満たせる要求なので 416 にはしない
  if (spec.includes(',')) return { kind: 'full' };

  const match = BYTES_RANGE_SPEC.exec(spec);
  if (!match) return { kind: 'unsatisfiable' };

  const [, startText = '', endText = ''] = match;
  if (startText === '') return resolveSuffix(endText, size);

  const start = Number(startText);
  if (!Number.isSafeInteger(start) || start >= size) return { kind: 'unsatisfiable' };
  if (endText === '') return { kind: 'partial', offset: start, length: size - start };

  const end = Number(endText);
  if (!Number.isSafeInteger(end) || end < start) return { kind: 'unsatisfiable' };

  // 実体より後ろまで要求されても末尾で止める（RFC 9110 14.1.1）
  const last = Math.min(end, size - 1);
  return { kind: 'partial', offset: start, length: last - start + 1 };
}

/** 206 の Content-Range。末尾の位置は範囲に含む。 */
export function partialContentRange(
  range: { offset: number; length: number },
  size: number
): string {
  return `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`;
}

/** 416 の Content-Range。満たせる範囲が無いことと総量だけを伝える。 */
export function unsatisfiedContentRange(size: number): string {
  return `bytes */${size}`;
}

/** `bytes=-N`（末尾 N バイト）を解決する。0 バイトの要求は満たせる範囲が無い。 */
function resolveSuffix(suffixText: string, size: number): ResolvedRange {
  if (suffixText === '') return { kind: 'unsatisfiable' };

  const suffix = Number(suffixText);
  if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0) {
    return { kind: 'unsatisfiable' };
  }

  const length = Math.min(suffix, size);
  return { kind: 'partial', offset: size - length, length };
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
