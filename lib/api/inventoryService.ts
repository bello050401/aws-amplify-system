import type {
  FieldChange,
  Item,
  ItemInput,
  KeywordSearchParams,
  SearchResult,
} from "@/lib/types";
import { DataSource, InsufficientStockError } from "./dataSource";

/**
 * 在庫業務ロジック層。
 *
 * PC版・iPhone/PWA版・将来のReact Native版はすべてこの1つのサービスを
 * 呼び出す。バックエンド実体(Mock/Amplify)が変わっても業務ルール
 * (在庫不足チェック・楽観ロック・履歴記録)は複製しない(指示書 §24)。
 */
export class InventoryService {
  constructor(private ds: DataSource) {}

  listCategories() {
    return this.ds.listCategories();
  }
  listLocations() {
    return this.ds.listLocations();
  }
  getItem(id: string) {
    return this.ds.getItem(id);
  }
  searchItems(params: KeywordSearchParams): Promise<SearchResult<Item>> {
    return this.ds.searchItems(params);
  }
  getItemHistory(itemId: string) {
    return this.ds.listHistoryByItem(itemId);
  }
  getItemMovements(itemId: string) {
    return this.ds.listMovementsByItem(itemId);
  }
  listMovements(type?: Parameters<DataSource["listMovements"]>[0]) {
    return this.ds.listMovements(type);
  }
  uploadImage(itemId: string, file: File) {
    return this.ds.uploadImage(itemId, file);
  }
  getImageUrl(key: string) {
    return this.ds.getImageUrl(key);
  }
  deleteImage(key: string) {
    return this.ds.deleteImage(key);
  }

  async createItem(input: ItemInput, actor: string, presetId?: string): Promise<Item> {
    const item = await this.ds.createItem(input, actor, presetId);
    await this.ds.createHistory({
      itemId: item.id,
      action: "CREATE",
      changes: [{ field: "name", oldValue: null, newValue: item.name }],
      changedBy: actor,
    });
    return item;
  }

  /** 既存在庫を元に新規在庫を複製する(指示書 §8-1)。IDは新規採番。 */
  async duplicateItem(sourceId: string, actor: string): Promise<Item> {
    const source = await this.ds.getItem(sourceId);
    if (!source) throw new Error("複製元の在庫が見つかりません");
    const { id, createdAt, updatedAt, version, isDeleted, ...rest } = source;
    const copy = await this.ds.createItem(
      { ...rest, name: `${rest.name}のコピー`, barcode: null },
      actor
    );
    await this.ds.createHistory({
      itemId: copy.id,
      action: "DUPLICATE",
      changes: [{ field: "sourceId", oldValue: null, newValue: sourceId }],
      changedBy: actor,
    });
    return copy;
  }

  async updateItem(
    id: string,
    patch: Partial<ItemInput>,
    expectedVersion: number,
    actor: string
  ): Promise<Item> {
    const before = await this.ds.getItem(id);
    const updated = await this.ds.updateItem(id, patch, expectedVersion, actor);
    const changes = diffFields(before, updated);
    if (changes.length > 0) {
      await this.ds.createHistory({ itemId: id, action: "UPDATE", changes, changedBy: actor });
    }
    return updated;
  }

  async deleteItem(id: string, actor: string): Promise<void> {
    await this.ds.softDeleteItem(id, actor);
    await this.ds.createHistory({
      itemId: id,
      action: "DELETE",
      changes: [{ field: "isDeleted", oldValue: false, newValue: true }],
      changedBy: actor,
    });
  }

  async bulkUpdate(ids: string[], patch: Partial<ItemInput>, actor: string): Promise<number> {
    const count = await this.ds.bulkUpdate(ids, patch, actor);
    await Promise.all(
      ids.map((id) =>
        this.ds.createHistory({
          itemId: id,
          action: "UPDATE",
          changes: Object.entries(patch).map(([field, newValue]) => ({
            field,
            oldValue: null,
            newValue,
          })),
          changedBy: actor,
        })
      )
    );
    return count;
  }

  /** 入庫 (指示書 §17) */
  async receiveStock(itemId: string, quantity: number, actor: string, note?: string): Promise<Item> {
    if (quantity <= 0) throw new Error("入庫数量は1以上を入力してください");
    const item = await this.ds.getItem(itemId);
    if (!item) throw new Error("在庫が見つかりません");
    const updated = await this.ds.updateItem(
      itemId,
      { quantity: item.quantity + quantity, freeQuantity: item.freeQuantity + quantity },
      item.version,
      actor
    );
    await this.ds.createMovement({
      itemId,
      type: "RECEIVE",
      quantity,
      note,
      operatorId: actor,
      operatorName: actor,
    });
    return updated;
  }

  /** 出庫 (指示書 §18)。在庫不足はエラー。 */
  async shipStock(itemId: string, quantity: number, actor: string, note?: string): Promise<Item> {
    if (quantity <= 0) throw new Error("出庫数量は1以上を入力してください");
    const item = await this.ds.getItem(itemId);
    if (!item) throw new Error("在庫が見つかりません");
    if (item.freeQuantity < quantity) {
      throw new InsufficientStockError(item.freeQuantity, quantity);
    }
    const updated = await this.ds.updateItem(
      itemId,
      { quantity: item.quantity - quantity, freeQuantity: item.freeQuantity - quantity },
      item.version,
      actor
    );
    await this.ds.createMovement({
      itemId,
      type: "SHIP",
      quantity,
      note,
      operatorId: actor,
      operatorName: actor,
    });
    return updated;
  }

  /** 保管場所間の数量移動 (指示書 §8-2, §15) */
  async moveStock(
    itemId: string,
    quantity: number,
    toLocationId: string,
    actor: string
  ): Promise<Item> {
    const item = await this.ds.getItem(itemId);
    if (!item) throw new Error("在庫が見つかりません");
    if (item.quantity < quantity) throw new InsufficientStockError(item.quantity, quantity);
    const fromLocationId = item.locationId;
    const updated = await this.ds.updateItem(
      itemId,
      { locationId: toLocationId },
      item.version,
      actor
    );
    await this.ds.createMovement({
      itemId,
      type: "MOVE",
      quantity,
      fromLocationId,
      toLocationId,
      operatorId: actor,
      operatorName: actor,
    });
    return updated;
  }

  /** 棚卸: 実数量を入力し現在数量との差分を反映 (指示書 §19) */
  async applyStocktake(
    itemId: string,
    countedQuantity: number,
    actor: string,
    stocktakeDate: string
  ): Promise<{ item: Item; diff: number }> {
    const item = await this.ds.getItem(itemId);
    if (!item) throw new Error("在庫が見つかりません");
    const diff = countedQuantity - item.quantity;
    const updated = await this.ds.updateItem(
      itemId,
      { quantity: countedQuantity, freeQuantity: countedQuantity, stocktakeDate },
      item.version,
      actor
    );
    await this.ds.createMovement({
      itemId,
      type: "STOCKTAKE",
      quantity: diff,
      note: `棚卸: 実数量${countedQuantity} (差分${diff >= 0 ? "+" : ""}${diff})`,
      operatorId: actor,
      operatorName: actor,
    });
    return { item: updated, diff };
  }

  /** バーコード/QRスキャン検索 (指示書 §10, §21)。編集画面のスキャナと同一ロジックを再利用。 */
  async searchByScannedCode(code: string): Promise<Item[]> {
    return this.ds.getItemByBarcode(code);
  }
}

function diffFields(before: Item | null, after: Item): FieldChange[] {
  if (!before) return [];
  const changes: FieldChange[] = [];
  const keys = Object.keys(after) as (keyof Item)[];
  for (const key of keys) {
    if (key === "updatedAt" || key === "version") continue;
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changes.push({ field: key, oldValue: before[key], newValue: after[key] });
    }
  }
  return changes;
}
