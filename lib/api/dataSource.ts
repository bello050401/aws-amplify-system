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

/**
 * 低レベルの永続化インターフェース。
 *
 * PC版・モバイル版・単体テストは、この1つのインターフェースの上に構築された
 * InventoryService(lib/api/inventoryService.ts)を共通利用する。
 * バックエンド実体だけが差し替え可能で、業務ロジックは複製しない。
 *
 * 実装:
 *  - AmplifyDataSource: AWS Amplify(AppSync/DynamoDB/S3) 本番実装
 *  - MockDataSource   : amplify_outputs.json 未生成時のローカル動作確認用
 */
export interface DataSource {
  // カテゴリ / 保管場所 ------------------------------------------------
  listCategories(): Promise<Category[]>;
  listLocations(): Promise<Location[]>;

  // 在庫 -----------------------------------------------------------------
  getItem(id: string): Promise<Item | null>;
  getItemByBarcode(barcode: string): Promise<Item[]>;
  searchItems(params: KeywordSearchParams): Promise<SearchResult<Item>>;
  createItem(input: ItemInput, actor: string, presetId?: string): Promise<Item>;
  /** version不一致時は OptimisticLockError を投げる */
  updateItem(id: string, patch: Partial<ItemInput>, expectedVersion: number, actor: string): Promise<Item>;
  softDeleteItem(id: string, actor: string): Promise<void>;
  bulkUpdate(ids: string[], patch: Partial<ItemInput>, actor: string): Promise<number>;

  // 入出庫・移動・棚卸履歴 -------------------------------------------------
  createMovement(movement: Omit<StockMovement, "id" | "createdAt">): Promise<StockMovement>;
  listMovements(type?: MovementType, limit?: number): Promise<StockMovement[]>;
  listMovementsByItem(itemId: string): Promise<StockMovement[]>;

  // 変更履歴 --------------------------------------------------------------
  createHistory(entry: Omit<ItemHistoryEntry, "id" | "changedAt">): Promise<ItemHistoryEntry>;
  listHistoryByItem(itemId: string): Promise<ItemHistoryEntry[]>;

  // 画像 -----------------------------------------------------------------
  uploadImage(itemId: string, file: File): Promise<string>; // returns storage key
  getImageUrl(key: string): Promise<string>;
  deleteImage(key: string): Promise<void>;
}

export class OptimisticLockError extends Error {
  constructor() {
    super("他の端末で更新されたため、最新のデータを取得してやり直してください。");
    this.name = "OptimisticLockError";
  }
}

export class InsufficientStockError extends Error {
  constructor(available: number, requested: number) {
    super(`在庫が不足しています(在庫数: ${available} / 出庫数: ${requested})`);
    this.name = "InsufficientStockError";
  }
}
