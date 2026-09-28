/** Narrow staging permission: create hidden items or hide an existing item only. */
export function isBasePrivateTestEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.BASE_PRIVATE_TEST_WRITES_ENABLED === "1";
}

export function assertBasePrivateTestWrite(
  path: string,
  params: Record<string, string | number>,
  env: Record<string, string | undefined> = process.env,
): void {
  const keys = Object.keys(params).sort().join(",");
  const privateAdd = path === "/items/add" && keys === "detail,price,stock,title,visible" && params.visible === 0;
  const privateHide = path === "/items/edit" && keys === "item_id,visible" && params.visible === 0 &&
    /^[1-9][0-9]*$/.test(String(params.item_id));
  if (!isBasePrivateTestEnabled(env) || (!privateAdd && !privateHide))
    throw new Error("BASEの非公開テスト登録が有効になっていません。");
}
