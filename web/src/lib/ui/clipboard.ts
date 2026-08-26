/** クリップボードへコピーし、失敗時は入力を選択して手動コピーへ誘導する。 */
export async function copyToClipboard(
  value: string,
  input: HTMLInputElement | null
): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    input?.select();
    return false;
  }
}
