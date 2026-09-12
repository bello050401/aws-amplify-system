/**
 * ImageProcessingPanel 実React境界試験(2026-09-13)専用モック。
 * app/inventory/useInventoryImageUrl.ts(実aws-amplify/storage・authに
 * 依存、S3署名URL解決)の代わりに差し込む——BeforeAfterToggleが
 * クラッシュせず描画できれば十分で、実際の署名解決は検証対象外。
 */
const FAKE_PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

export function useInventoryImageUrl(key: string | null): { url: string | null; error: string | null } {
  return { url: key ? FAKE_PIXEL : null, error: null };
}
