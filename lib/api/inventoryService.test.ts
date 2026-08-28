import { beforeEach, describe, expect, it } from "vitest";
import { MockDataSource } from "./mockDataSource";
import { InventoryService } from "./inventoryService";
import { InsufficientStockError, OptimisticLockError } from "./dataSource";

/**
 * 実AWS(AppSync/DynamoDB)は本セッションからデプロイ・接続できないため、
 * ローカルMockDataSourceを通してInventoryServiceの業務ロジック
 * (入出庫・移動・棚卸・楽観ロック・履歴記録)を検証する。
 * AmplifyDataSourceも同一のDataSourceインターフェースを実装しているため、
 * 実バックエンドデプロイ後は同じ契約で動作する想定。
 */
describe("InventoryService", () => {
  let service: InventoryService;

  beforeEach(() => {
    service = new InventoryService(new MockDataSource());
  });

  it("creates an item and records CREATE history", async () => {
    const item = await service.createItem(
      {
        name: "テストソファ",
        quantity: 3,
        freeQuantity: 3,
        unit: "点",
        imageKeys: [],
      } as never,
      "tester@example.com"
    );
    expect(item.id).toBeTruthy();
    expect(item.version).toBe(1);
    const history = await service.getItemHistory(item.id);
    expect(history.some((h) => h.action === "CREATE")).toBe(true);
  });

  it("receiveStock increases quantity and freeQuantity, records movement", async () => {
    const [item] = (await service.searchItems({ pageSize: 1 })).items;
    const before = item.quantity;
    const updated = await service.receiveStock(item.id, 4, "tester");
    expect(updated.quantity).toBe(before + 4);
    expect(updated.freeQuantity).toBe(item.freeQuantity + 4);
    const movements = await service.getItemMovements(item.id);
    expect(movements.some((m) => m.type === "RECEIVE" && m.quantity === 4)).toBe(true);
  });

  it("shipStock decreases quantity and rejects insufficient stock", async () => {
    const [item] = (await service.searchItems({ pageSize: 1 })).items;
    await expect(service.shipStock(item.id, item.freeQuantity + 100, "tester")).rejects.toThrow(
      InsufficientStockError
    );
    const updated = await service.shipStock(item.id, 1, "tester");
    expect(updated.quantity).toBe(item.quantity - 1);
  });

  it("moveStock changes locationId and records from/to", async () => {
    const [item] = (await service.searchItems({ pageSize: 1 })).items;
    const locations = await service.listLocations();
    const target = locations.find((l) => l.id !== item.locationId)!;
    const updated = await service.moveStock(item.id, item.quantity, target.id, "tester");
    expect(updated.locationId).toBe(target.id);
    const movements = await service.getItemMovements(item.id);
    expect(movements.some((m) => m.type === "MOVE" && m.toLocationId === target.id)).toBe(true);
  });

  it("applyStocktake computes diff and updates stocktakeDate", async () => {
    const [item] = (await service.searchItems({ pageSize: 1 })).items;
    const { item: updated, diff } = await service.applyStocktake(item.id, item.quantity + 2, "tester", "2026-08-28");
    expect(diff).toBe(2);
    expect(updated.quantity).toBe(item.quantity + 2);
    expect(updated.stocktakeDate).toBe("2026-08-28");
  });

  it("updateItem rejects stale version with OptimisticLockError", async () => {
    const [item] = (await service.searchItems({ pageSize: 1 })).items;
    await service.updateItem(item.id, { name: "更新後" }, item.version, "tester");
    await expect(service.updateItem(item.id, { name: "二重更新" }, item.version, "tester")).rejects.toThrow(
      OptimisticLockError
    );
  });

  it("duplicateItem creates a new id and copies fields", async () => {
    const [item] = (await service.searchItems({ pageSize: 1 })).items;
    const copy = await service.duplicateItem(item.id, "tester");
    expect(copy.id).not.toBe(item.id);
    expect(copy.name).toContain(item.name);
    expect(copy.quantity).toBe(item.quantity);
  });

  it("deleteItem soft-deletes (item no longer returned by getItem)", async () => {
    const [item] = (await service.searchItems({ pageSize: 1 })).items;
    await service.deleteItem(item.id, "tester");
    expect(await service.getItem(item.id)).toBeNull();
  });

  it("bulkUpdate applies patch to all selected ids", async () => {
    const { items } = await service.searchItems({ pageSize: 3 });
    const ids = items.map((i) => i.id);
    const count = await service.bulkUpdate(ids, { status: "検品中" } as never, "tester");
    expect(count).toBe(ids.length);
    for (const id of ids) {
      const updated = await service.getItem(id);
      expect(updated?.status).toBe("検品中");
    }
  });

  it("searchByScannedCode finds by exact barcode", async () => {
    const [item] = (await service.searchItems({ pageSize: 1 })).items;
    const matches = await service.searchByScannedCode(item.barcode!);
    expect(matches.map((m) => m.id)).toContain(item.id);
  });
});
