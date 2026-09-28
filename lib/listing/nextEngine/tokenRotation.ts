/** Next Engine may rotate both tokens on any API response, including errors.
 * Persist a complete pair atomically before the next request; never expose it
 * to the browser. https://developer.next-engine.com/guides/auth/
 */
export function resolveNextEngineTokenRotation(
  current: { accessToken: string; refreshToken: string },
  response: unknown,
): { accessToken: string; refreshToken: string; rotated: boolean } {
  if (!current.accessToken || !current.refreshToken) {
    throw new Error("ネクストエンジンの保存済み認証情報が不足しています。");
  }
  if (!response || typeof response !== "object") {
    throw new Error("ネクストエンジンの応答が不正です。");
  }
  const data = response as Record<string, unknown>;
  const hasAccess = Object.prototype.hasOwnProperty.call(data, "access_token");
  const hasRefresh = Object.prototype.hasOwnProperty.call(data, "refresh_token");
  if (hasAccess !== hasRefresh) {
    throw new Error("ネクストエンジンの認証情報を安全に更新できませんでした。");
  }
  if (!hasAccess) return { ...current, rotated: false };
  if (typeof data.access_token !== "string" || !data.access_token ||
      typeof data.refresh_token !== "string" || !data.refresh_token) {
    throw new Error("ネクストエンジンの認証情報を安全に更新できませんでした。");
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token, rotated: true };
}
