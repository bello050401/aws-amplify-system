/**
 * 第六ラウンド§14(P0-3): EC出品一覧 → 自動値下げルール一括割当ページ
 * への「選択商品ID」引き渡し。
 *
 * 第五ラウンドP0-B/第四ラウンドで実際に発生したHTTP 431の教訓
 * (InventoryPagination.tsxのnextTokenスタック問題と同根 — 選択IDの
 * 集合をクエリ文字列へ直列化すると、選択件数が増えるほどURLが際限なく
 * 肥大化し得る)を踏まえ、選択IDは**URLへ一切載せない**。
 *
 * 同一タブ内の画面遷移(EC出品一覧→割当ページ)だけで完結する一時的な
 * 状態であり、ブラウザを閉じれば消えて構わない性質のデータのため、
 * 新しいAWSモデル/Server-side draftを追加するのではなく
 * `sessionStorage`(同一タブ内でのみ有効、タブを閉じると自動的に消える)
 * を使う——このデータのために新規のDynamoDBテーブルとTTL管理を追加する
 * のは過剰設計と判断した。
 */
const STORAGE_KEY = "bello:pricingRuleAssignSelection";

export function savePricingAssignmentSelection(inventoryIds: string[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(inventoryIds));
  } catch {
    // sessionStorageが使えない環境(プライベートブラウジング等)でも
    // 遷移自体は妨げない——遷移先ページが空配列として扱い、
    // 「選択情報が見つかりません」と案内する。
  }
}

export function loadPricingAssignmentSelection(): string[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function clearPricingAssignmentSelection(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // no-op
  }
}
