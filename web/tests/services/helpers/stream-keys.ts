/** テスト実行時だけ使うRSA PKCS#8秘密鍵を生成してbase64化する。 */
export async function generateTestPrivateKeyBase64(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let binary = '';
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  return btoa(binary);
}
