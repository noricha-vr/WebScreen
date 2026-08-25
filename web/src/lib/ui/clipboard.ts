/**
 * クリップボードへのコピー。権限が無い環境では入力を選択状態にして手動コピーへ誘導する。
 *
 * convert-panel.ts にも同じ処理があるが、あちらはアップロードフローの差し替え中のため
 * 触っていない。差し替えが落ち着いたらこちらへ寄せる。
 */
export async function copyToClipboard(
  value: string,
  input: HTMLInputElement | null
): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    input?.select();
  }
}
