/** Cloudflare adapter が実行時に提供する Worker bindings。各エントリポイントで具体型に絞る。 */
declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>;
}
