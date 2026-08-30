/**
 * 用途別ページ（Web / 画面共有 / 画像 / PDF）のページキーと URL スラッグの対応。
 *
 * 辞書 `useCases` のキーと 1 対 1 で、宣言順が関連リンクの並び順も兼ねる。
 * キーをそのまま URL にしない（screenShare はハイフン区切りの screen-share で公開している）。
 *
 * ページ本体（UseCaseArticle）とルート（src/pages/{lang}/*.astro のパンくず）の両方が参照するので、
 * どちらか一方に置かず独立させている。
 */
export const USE_CASE_SLUGS = {
  web: 'web',
  screenShare: 'screen-share',
  image: 'image',
  pdf: 'pdf',
} as const;

/** 辞書 useCases のページキー。 */
export type UseCasePage = keyof typeof USE_CASE_SLUGS;

/** 用途別ページの URL パス（`trailingSlash: 'always'` に合わせて末尾スラッシュ付き）。 */
export function useCasePath(lang: string, page: UseCasePage): string {
  return `/${lang}/${USE_CASE_SLUGS[page]}/`;
}
