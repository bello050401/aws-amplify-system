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
import { matchesAdvancedQuery, matchesKeyword } from "@/lib/search/buildFilter";
import { DataSource, OptimisticLockError } from "./dataSource";

/**
 * amplify_outputs.json が存在しない環境(このコーディング環境や、まだ
 * `npx ampx sandbox` を実行していない開発端末)向けのローカル動作確認用実装。
 *
 * ブラウザの localStorage に永続化するため、リロードやPWAホーム画面起動を
 * またいで検索・編集・入出庫・棚卸の一連の操作を実際に試すことができる。
 * 実AWSバックエンドをデプロイした後は AmplifyDataSource に自動的に切り替わる
 * (lib/api/index.ts)。
 */

const STORAGE_KEY = "bello-mock-inventory-v1";

interface MockDB {
  categories: Category[];
  locations: Location[];
  items: Item[];
  movements: StockMovement[];
  histories: ItemHistoryEntry[];
  images: Record<string, string>; // key -> data URL
}

let idSeq = 1;
function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${Date.now().toString(36)}${idSeq.toString(36)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function seedDB(): MockDB {
  const categories: Category[] = [
    { id: "cat_sofa", name: "ソファ", sortOrder: 1 },
    { id: "cat_table", name: "テーブル", sortOrder: 2 },
    { id: "cat_chair", name: "椅子", sortOrder: 3 },
    { id: "cat_shelf", name: "棚・収納", sortOrder: 4 },
    { id: "cat_bed", name: "ベッド", sortOrder: 5 },
    { id: "cat_appliance", name: "家電", sortOrder: 6 },
    { id: "cat_misc", name: "雑貨", sortOrder: 7 },
  ];
  const locations: Location[] = [
    { id: "loc_a1", name: "倉庫A-1", code: "A1" },
    { id: "loc_a2", name: "倉庫A-2", code: "A2" },
    { id: "loc_b1", name: "倉庫B-1", code: "B1" },
    { id: "loc_showroom", name: "ショールーム", code: "SR" },
    { id: "loc_studio", name: "撮影スタジオ", code: "ST" },
  ];

  const statuses = ["出品待ち", "入金待ち", "販売中", "撮影待ち", "検品中"];
  const items: Item[] = Array.from({ length: 48 }).map((_, i) => {
    const cat = categories[i % categories.length];
    const loc = locations[i % locations.length];
    const qty = (i % 7) + 1;
    return {
      id: nextId("item"),
      name: `${cat.name}サンプル品 ${String(i + 1).padStart(3, "0")}`,
      barcode: `4900000${String(100000 + i)}`,
      quantity: qty,
      freeQuantity: qty,
      reorderPoint: 1,
      unit: "点",
      status: statuses[i % statuses.length],
      notes: i % 5 === 0 ? "販売サイト掲載済み。傷は写真参照。送料は地域により変動あり。" : null,
      categoryId: cat.id,
      locationId: loc.id,
      thumbnailKey: null,
      imageKeys: [],
      plannedPrice: 8000 + i * 350,
      discountPrice30: 7000 + i * 300,
      discountPrice60: 6000 + i * 250,
      discountPrice90: 5000 + i * 200,
      condition: (i % 5) + 1,
      damageNotes: i % 4 === 0 ? "脚部に小さな傷あり" : null,
      widthCm: 40 + (i % 10) * 3,
      depthCm: 30 + (i % 8) * 2,
      heightCm: 50 + (i % 6) * 4,
      lengthCm: 60 + (i % 9) * 3,
      householdCategory: i % 2 === 0 ? "家具" : "家電",
      itemType: cat.name,
      transactionDate: "2026-06-01",
      antiqueFeature: "使用感あり・クリーニング済み",
      stocktakeDate: "2026-08-01",
      isDeleted: false,
      version: 1,
      userGroup: "Staff",
      updatedBy: "system-seed",
      createdBy: "system-seed",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    } satisfies Item;
  });

  return { categories, locations, items, movements: [], histories: [], images: {} };
}

function loadDB(): MockDB {
  if (typeof window === "undefined") return seedDB();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as MockDB;
  } catch {
    // ignore corrupt storage
  }
  const db = seedDB();
  saveDB(db);
  return db;
}

function saveDB(db: MockDB) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch {
    // localStorage full or unavailable - degrade silently, data stays in memory only
  }
}

export class MockDataSource implements DataSource {
  private db: MockDB;

  constructor() {
    this.db = loadDB();
  }

  private persist() {
    saveDB(this.db);
  }

  async listCategories(): Promise<Category[]> {
    return [...this.db.categories].sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async listLocations(): Promise<Location[]> {
    return [...this.db.locations];
  }

  async getItem(id: string): Promise<Item | null> {
    return this.db.items.find((i) => i.id === id && !i.isDeleted) ?? null;
  }

  async getItemByBarcode(barcode: string): Promise<Item[]> {
    return this.db.items.filter((i) => !i.isDeleted && i.barcode === barcode);
  }

  async searchItems(params: KeywordSearchParams): Promise<SearchResult<Item>> {
    let results = this.db.items.filter((i) => !i.isDeleted);

    if (params.keyword) {
      results = results.filter((i) => matchesKeyword(i, params.keyword!));
    }
    if (params.categoryId) {
      results = results.filter((i) => i.categoryId === params.categoryId);
    }
    if (params.advanced) {
      results = results.filter((i) => matchesAdvancedQuery(i, params.advanced!));
    }

    if (params.sort) {
      const { field, direction } = params.sort;
      results = [...results].sort((a, b) => {
        const av = (a as unknown as Record<string, unknown>)[field];
        const bv = (b as unknown as Record<string, unknown>)[field];
        if (av === bv) return 0;
        const cmp = (av ?? "") > (bv ?? "") ? 1 : -1;
        return direction === "asc" ? cmp : -cmp;
      });
    } else {
      results = [...results].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }

    const totalCount = results.length;
    const totalQuantity = results.reduce((sum, i) => sum + (i.quantity || 0), 0);

    const pageSize = params.pageSize ?? 20;
    const page = params.page ?? 1;
    const start = (page - 1) * pageSize;
    const paged = results.slice(start, start + pageSize);

    return {
      items: paged,
      totalCount,
      totalQuantity,
      nextToken: start + pageSize < totalCount ? String(page + 1) : null,
    };
  }

  async createItem(input: ItemInput, actor: string, presetId?: string): Promise<Item> {
    const item: Item = {
      ...input,
      id: presetId ?? nextId("item"),
      imageKeys: input.imageKeys ?? [],
      isDeleted: false,
      version: 1,
      createdBy: actor,
      updatedBy: actor,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.db.items.unshift(item);
    this.persist();
    return item;
  }

  async updateItem(
    id: string,
    patch: Partial<ItemInput>,
    expectedVersion: number,
    actor: string
  ): Promise<Item> {
    const idx = this.db.items.findIndex((i) => i.id === id);
    if (idx === -1) throw new Error("在庫が見つかりません");
    const current = this.db.items[idx];
    if (current.version !== expectedVersion) {
      throw new OptimisticLockError();
    }
    const updated: Item = {
      ...current,
      ...patch,
      version: current.version + 1,
      updatedBy: actor,
      updatedAt: nowIso(),
    };
    this.db.items[idx] = updated;
    this.persist();
    return updated;
  }

  async softDeleteItem(id: string, actor: string): Promise<void> {
    const idx = this.db.items.findIndex((i) => i.id === id);
    if (idx === -1) return;
    this.db.items[idx] = {
      ...this.db.items[idx],
      isDeleted: true,
      updatedBy: actor,
      updatedAt: nowIso(),
    };
    this.persist();
  }

  async bulkUpdate(ids: string[], patch: Partial<ItemInput>, actor: string): Promise<number> {
    let count = 0;
    this.db.items = this.db.items.map((i) => {
      if (ids.includes(i.id)) {
        count += 1;
        return { ...i, ...patch, version: i.version + 1, updatedBy: actor, updatedAt: nowIso() };
      }
      return i;
    });
    this.persist();
    return count;
  }

  async createMovement(movement: Omit<StockMovement, "id" | "createdAt">): Promise<StockMovement> {
    const m: StockMovement = { ...movement, id: nextId("mv"), createdAt: nowIso() };
    this.db.movements.unshift(m);
    this.persist();
    return m;
  }

  async listMovements(type?: MovementType, limit = 100): Promise<StockMovement[]> {
    const filtered = type ? this.db.movements.filter((m) => m.type === type) : this.db.movements;
    return filtered.slice(0, limit);
  }

  async listMovementsByItem(itemId: string): Promise<StockMovement[]> {
    return this.db.movements.filter((m) => m.itemId === itemId);
  }

  async createHistory(entry: Omit<ItemHistoryEntry, "id" | "changedAt">): Promise<ItemHistoryEntry> {
    const h: ItemHistoryEntry = { ...entry, id: nextId("hist"), changedAt: nowIso() };
    this.db.histories.unshift(h);
    this.persist();
    return h;
  }

  async listHistoryByItem(itemId: string): Promise<ItemHistoryEntry[]> {
    return this.db.histories.filter((h) => h.itemId === itemId);
  }

  async uploadImage(itemId: string, file: File): Promise<string> {
    const key = `items/${itemId}/${nextId("img")}-${file.name}`;
    const dataUrl = await fileToDataUrl(file);
    this.db.images[key] = dataUrl;
    this.persist();
    return key;
  }

  async getImageUrl(key: string): Promise<string> {
    return this.db.images[key] ?? "";
  }

  async deleteImage(key: string): Promise<void> {
    delete this.db.images[key];
    this.persist();
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
