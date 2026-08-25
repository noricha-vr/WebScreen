/** Cloudflare adapter が実行時に提供する Worker bindings。 */
declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>;
}
