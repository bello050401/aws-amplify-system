import { generateClient } from "aws-amplify/data";
import { getUrl, remove, uploadData } from "aws-amplify/storage";
import type { Schema } from "@/amplify/data/resource";
import type {
  Category,
  Item,
  ItemHistoryEntry,
  ItemInput,
  KeywordSearchParams,
  Location,
  MovementType,
  SearchResult,
  StockMovement,
} from "@/lib/types";
import { combineFilters, advancedQueryToGraphQLFilter, keywordToGraphQLFilter } from "@/lib/search/toGraphQLFilter";
import { DataSource, OptimisticLockError } from "./dataSource";

/**
 * 実AWSバックエンド(AppSync/DynamoDB/S3)実装。
 *
 * PC版・モバイル版はこの1つの実装(=1つのAPI・1つのデータ)を共有する。
 * amplify_outputs.json がプレースホルダーでない(=デプロイ済み)場合に
 * lib/api/index.ts から自動選択される。
 */

type ItemRecord = Schema["Item"]["type"];

function toDomainItem(r: ItemRecord): Item {
  return {
    id: r.id,
    name: r.name,
    barcode: r.barcode ?? null,
    quantity: r.quantity ?? 0,
    freeQuantity: r.freeQuantity ?? 0,
    reorderPoint: r.reorderPoint ?? null,
    unit: r.unit ?? "個",
    status: r.status ?? null,
    notes: r.notes ?? null,
    categoryId: r.categoryId ?? null,
    locationId: r.locationId ?? null,
    thumbnailKey: r.thumbnailKey ?? null,
    imageKeys: (r.imageKeys ?? []).filter((k): k is string => !!k),
    plannedPrice: r.plannedPrice ?? null,
    discountPrice30: r.discountPrice30 ?? null,
    discountPrice60: r.discountPrice60 ?? null,
    discountPrice90: r.discountPrice90 ?? null,
    condition: r.condition ?? null,
    damageNotes: r.damageNotes ?? null,
    widthCm: r.widthCm ?? null,
    depthCm: r.depthCm ?? null,
    heightCm: r.heightCm ?? null,
    lengthCm: r.lengthCm ?? null,
    householdCategory: r.householdCategory ?? null,
    itemType: r.itemType ?? null,
    transactionDate: r.transactionDate ?? null,
    antiqueFeature: r.antiqueFeature ?? null,
    stocktakeDate: r.stocktakeDate ?? null,
    isDeleted: r.isDeleted ?? false,
    version: r.version ?? 1,
    userGroup: r.userGroup ?? null,
    updatedBy: r.updatedBy ?? null,
    createdBy: r.createdBy ?? null,
    createdAt: r.createdAt ?? new Date().toISOString(),
    updatedAt: r.updatedAt ?? new Date().toISOString(),
  };
}

export class AmplifyDataSource implements DataSource {
  private client = generateClient<Schema>();

  async listCategories(): Promise<Category[]> {
    const { data } = await this.client.models.Category.list({ limit: 500 });
    return data
      .map((c) => ({ id: c.id, name: c.name, sortOrder: c.sortOrder ?? 0 }))
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async listLocations(): Promise<Location[]> {
    const { data } = await this.client.models.Location.list({ limit: 500 });
    return data.map((l) => ({ id: l.id, name: l.name, code: l.code ?? null }));
  }

  async getItem(id: string): Promise<Item | null> {
    const { data } = await this.client.models.Item.get({ id });
    if (!data || data.isDeleted) return null;
    return toDomainItem(data);
  }

  async getItemByBarcode(barcode: string): Promise<Item[]> {
    const { data } = await this.client.models.Item.listItemByBarcode({ barcode });
    return data.filter((d) => !d.isDeleted).map(toDomainItem);
  }

  async searchItems(params: KeywordSearchParams): Promise<SearchResult<Item>> {
    const filter = combineFilters(
      { isDeleted: { ne: true } },
      params.keyword ? keywordToGraphQLFilter(params.keyword) : undefined,
      params.categoryId ? { categoryId: { eq: params.categoryId } } : undefined,
      params.advanced ? advancedQueryToGraphQLFilter(params.advanced) : undefined
    );

    // AppSync/DynamoDBのfilterはスキャン後フィルタのため、正確な件数・合計数量を
    // 得るには全件取得が必要。5,000件規模を想定し、limitを大きめに一括取得した上で
    // アプリ側でページングする(サーバー側sort非対応のためクライアントソート)。
    // 将来的に件数が増える場合は集計用のLambda/Query別建てを検討。
    let items: Item[] = [];
    let nextToken: string | undefined;
    do {
      const page = await this.client.models.Item.list({
        filter,
        limit: 1000,
        nextToken,
      });
      items = items.concat(page.data.map(toDomainItem));
      nextToken = page.nextToken ?? undefined;
    } while (nextToken);

    if (params.sort) {
      const { field, direction } = params.sort;
      items = items.sort((a, b) => {
        const av = (a as unknown as Record<string, unknown>)[field];
        const bv = (b as unknown as Record<string, unknown>)[field];
        if (av === bv) return 0;
        const cmp = (av ?? "") > (bv ?? "") ? 1 : -1;
        return direction === "asc" ? cmp : -cmp;
      });
    } else {
      items = items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    const totalCount = items.length;
    const totalQuantity = items.reduce((sum, i) => sum + (i.quantity || 0), 0);

    const pageSize = params.pageSize ?? 20;
    const page = params.page ?? 1;
    const start = (page - 1) * pageSize;
    const paged = items.slice(start, start + pageSize);

    return {
      items: paged,
      totalCount,
      totalQuantity,
      nextToken: start + pageSize < totalCount ? String(page + 1) : null,
    };
  }

  async createItem(input: ItemInput, actor: string, presetId?: string): Promise<Item> {
    const { data, errors } = await this.client.models.Item.create({
      ...(presetId ? { id: presetId } : {}),
      ...input,
      imageKeys: input.imageKeys ?? [],
      isDeleted: false,
      version: 1,
      createdBy: actor,
      updatedBy: actor,
    });
    if (errors?.length || !data) {
      throw new Error(errors?.map((e) => e.message).join(", ") ?? "作成に失敗しました");
    }
    return toDomainItem(data);
  }

  async updateItem(
    id: string,
    patch: Partial<ItemInput>,
    expectedVersion: number,
    actor: string
  ): Promise<Item> {
    const { data: current } = await this.client.models.Item.get({ id });
    if (!current) throw new Error("在庫が見つかりません");
    if ((current.version ?? 1) !== expectedVersion) {
      throw new OptimisticLockError();
    }
    const { data, errors } = await this.client.models.Item.update({
      id,
      ...patch,
      version: expectedVersion + 1,
      updatedBy: actor,
    });
    if (errors?.length || !data) {
      throw new Error(errors?.map((e) => e.message).join(", ") ?? "更新に失敗しました");
    }
    return toDomainItem(data);
  }

  async softDeleteItem(id: string, actor: string): Promise<void> {
    await this.client.models.Item.update({ id, isDeleted: true, updatedBy: actor });
  }

  async bulkUpdate(ids: string[], patch: Partial<ItemInput>, actor: string): Promise<number> {
    let count = 0;
    for (const id of ids) {
      const { data: current } = await this.client.models.Item.get({ id });
      if (!current) continue;
      await this.client.models.Item.update({
        id,
        ...patch,
        version: (current.version ?? 1) + 1,
        updatedBy: actor,
      });
      count += 1;
    }
    return count;
  }

  async createMovement(movement: Omit<StockMovement, "id" | "createdAt">): Promise<StockMovement> {
    const { data, errors } = await this.client.models.StockMovement.create(movement);
    if (errors?.length || !data) {
      throw new Error(errors?.map((e) => e.message).join(", ") ?? "履歴の作成に失敗しました");
    }
    return {
      id: data.id,
      itemId: data.itemId,
      type: data.type as MovementType,
      quantity: data.quantity,
      fromLocationId: data.fromLocationId ?? null,
      toLocationId: data.toLocationId ?? null,
      note: data.note ?? null,
      operatorId: data.operatorId ?? null,
      operatorName: data.operatorName ?? null,
      createdAt: data.createdAt ?? new Date().toISOString(),
    };
  }

  async listMovements(type?: MovementType, limit = 100): Promise<StockMovement[]> {
    const { data } = await this.client.models.StockMovement.list({
      filter: type ? { type: { eq: type } } : undefined,
      limit,
    });
    return data
      .map((m) => ({
        id: m.id,
        itemId: m.itemId,
        type: m.type as MovementType,
        quantity: m.quantity,
        fromLocationId: m.fromLocationId ?? null,
        toLocationId: m.toLocationId ?? null,
        note: m.note ?? null,
        operatorId: m.operatorId ?? null,
        operatorName: m.operatorName ?? null,
        createdAt: m.createdAt ?? new Date().toISOString(),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listMovementsByItem(itemId: string): Promise<StockMovement[]> {
    const { data } = await this.client.models.StockMovement.listStockMovementByItemId({ itemId });
    return data
      .map((m) => ({
        id: m.id,
        itemId: m.itemId,
        type: m.type as MovementType,
        quantity: m.quantity,
        fromLocationId: m.fromLocationId ?? null,
        toLocationId: m.toLocationId ?? null,
        note: m.note ?? null,
        operatorId: m.operatorId ?? null,
        operatorName: m.operatorName ?? null,
        createdAt: m.createdAt ?? new Date().toISOString(),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async createHistory(entry: Omit<ItemHistoryEntry, "id" | "changedAt">): Promise<ItemHistoryEntry> {
    const { data, errors } = await this.client.models.ItemHistory.create({
      itemId: entry.itemId,
      action: entry.action,
      changesJson: JSON.stringify(entry.changes),
      changedBy: entry.changedBy,
    });
    if (errors?.length || !data) {
      throw new Error(errors?.map((e) => e.message).join(", ") ?? "履歴の作成に失敗しました");
    }
    return {
      id: data.id,
      itemId: data.itemId,
      action: data.action as ItemHistoryEntry["action"],
      changes: entry.changes,
      changedBy: data.changedBy ?? null,
      changedAt: data.createdAt ?? new Date().toISOString(),
    };
  }

  async listHistoryByItem(itemId: string): Promise<ItemHistoryEntry[]> {
    const { data } = await this.client.models.ItemHistory.listItemHistoryByItemId({ itemId });
    return data
      .map((h) => ({
        id: h.id,
        itemId: h.itemId,
        action: h.action as ItemHistoryEntry["action"],
        changes: safeParseChanges(h.changesJson),
        changedBy: h.changedBy ?? null,
        changedAt: h.createdAt ?? new Date().toISOString(),
      }))
      .sort((a, b) => b.changedAt.localeCompare(a.changedAt));
  }

  async uploadImage(itemId: string, file: File): Promise<string> {
    const ext = file.name.split(".").pop() || "jpg";
    const key = `items/${itemId}/${crypto.randomUUID()}.${ext}`;
    await uploadData({ path: key, data: file, options: { contentType: file.type } }).result;
    return key;
  }

  async getImageUrl(key: string): Promise<string> {
    const { url } = await getUrl({ path: key });
    return url.toString();
  }

  async deleteImage(key: string): Promise<void> {
    await remove({ path: key });
  }
}

function safeParseChanges(json?: string | null): ItemHistoryEntry["changes"] {
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}
