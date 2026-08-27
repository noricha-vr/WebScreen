import type { UploadKind } from '../contracts/api';

type LocalUploadKind = Exclude<UploadKind, 'web'>;

interface InputFormat {
  extension: string;
  kind: LocalUploadKind;
  mimeTypes: readonly string[];
  matchesSignature: (header: Uint8Array) => boolean;
}

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const GIF87A_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61] as const;
const GIF89A_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61] as const;
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const;
const WEBP_SIGNATURE_OFFSET = 8;
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50] as const;
const SIGNATURE_HEADER_BYTES = 12;
const GENERIC_MIME_TYPES = new Set(['', 'application/octet-stream', 'application/binary']);

function startsWith(header: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return header.length >= offset + signature.length && signature.every((byte, index) => header[offset + index] === byte);
}

/** ローカル入力として受け付ける形式の正本。picker と D&D の両方がここから派生する。 */
export const INPUT_FORMATS: readonly InputFormat[] = [
  { extension: 'pdf', kind: 'pdf', mimeTypes: ['application/pdf'], matchesSignature: (header) => startsWith(header, PDF_SIGNATURE) },
  { extension: 'png', kind: 'image', mimeTypes: ['image/png'], matchesSignature: (header) => startsWith(header, PNG_SIGNATURE) },
  { extension: 'jpg', kind: 'image', mimeTypes: ['image/jpeg'], matchesSignature: (header) => startsWith(header, JPEG_SIGNATURE) },
  { extension: 'jpeg', kind: 'image', mimeTypes: ['image/jpeg'], matchesSignature: (header) => startsWith(header, JPEG_SIGNATURE) },
  { extension: 'webp', kind: 'image', mimeTypes: ['image/webp'], matchesSignature: (header) => startsWith(header, RIFF_SIGNATURE) && startsWith(header, WEBP_SIGNATURE, WEBP_SIGNATURE_OFFSET) },
  { extension: 'gif', kind: 'image', mimeTypes: ['image/gif'], matchesSignature: (header) => startsWith(header, GIF87A_SIGNATURE) || startsWith(header, GIF89A_SIGNATURE) },
];

/** <input type="file"> の accept 属性。対応形式の正本から生成する。 */
export const ACCEPT_ATTRIBUTE = INPUT_FORMATS.map((format) => `.${format.extension}`).join(',');

export type InputPreflightResult =
  | { ok: true; kind: LocalUploadKind }
  | { ok: false };

/** ファイル名の拡張子からローカル変換種別を識別する。 */
export function detectInputKind(filename: string): LocalUploadKind | null {
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  return INPUT_FORMATS.find((format) => format.extension === extension)?.kind ?? null;
}

/** 署名・拡張子・補助 MIME を突き合わせ、変換前の UX 候補として検査する。 */
export async function preflightInputFiles(files: readonly File[]): Promise<InputPreflightResult> {
  if (files.length === 0) return { ok: false };

  const formats = await Promise.all(files.map(preflightInputFile));
  if (formats.some((format) => format === null)) return { ok: false };

  const first = formats[0]!;
  if (formats.some((format) => format!.kind !== first.kind)) return { ok: false };
  if (first.kind === 'pdf' && files.length !== 1) return { ok: false };
  return { ok: true, kind: first.kind };
}

async function preflightInputFile(file: File): Promise<InputFormat | null> {
  const format = findFormat(file.name);
  if (!format || isRejectedMimeType(file.type)) return null;

  const header = new Uint8Array(await file.slice(0, SIGNATURE_HEADER_BYTES).arrayBuffer());
  if (!format.matchesSignature(header)) return null;
  return matchesKnownMimeType(file.type, format) ? format : null;
}

function findFormat(filename: string): InputFormat | undefined {
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  return INPUT_FORMATS.find((format) => format.extension === extension);
}

function isRejectedMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase().startsWith('video/');
}

function matchesKnownMimeType(mimeType: string, format: InputFormat): boolean {
  const normalized = mimeType.toLowerCase();
  if (GENERIC_MIME_TYPES.has(normalized)) return true;

  const knownFormat = INPUT_FORMATS.find((candidate) => candidate.mimeTypes.includes(normalized));
  return knownFormat === undefined || format.mimeTypes.includes(normalized);
}
