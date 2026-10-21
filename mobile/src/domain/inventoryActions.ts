import type { InventoryItem } from "./inventory";
import { InventoryWriteError } from "./editor";

export interface DeleteRequest { id: string; expectedUpdatedAt: string }
export interface DeletePorts { online: () => Promise<boolean>; removeInventory: (request: DeleteRequest) => Promise<void> }

/** The source remains untouched. No request is sent until the new form is saved. */
export function inventoryCopyDraft(source: InventoryItem, id: string, now: string): InventoryItem {
  return { ...source, id, sku: "保存時に自動採番", displayId: undefined, updatedAt: now, listUpdatedAt: now, createdAt: undefined,
    details: { ...source.details }, photos: source.photos?.map(photo => ({ ...photo })) };
}

/** Caller must show the final confirmation before invoking this operation. Never queue a deletion offline. */
export async function removeConfirmedInventory(item: InventoryItem, ports: DeletePorts): Promise<void> {
  if (!await ports.online()) throw new InventoryWriteError("offline");
  await ports.removeInventory({ id: item.id, expectedUpdatedAt: item.updatedAt });
}

export function deletionWarning(error: unknown): string {
  const kind = error instanceof InventoryWriteError ? error.kind : "uncertain";
  return kind === "offline" ? "【圏外です】" : kind === "unauthorized" ? "ログインの有効期限が切れました。" : kind === "forbidden" ? "削除する権限がありません。" :
    kind === "conflict" ? "別の操作で商品が更新されています。キャンセルして最新の商品詳細を確認してください。" :
    "削除結果を確認できませんでした。通信状態を確認して、もう一度「削除する」を押してください。";
}
