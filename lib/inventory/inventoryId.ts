/**
 * BELLOの「在庫ID」= ユーザーに見せる商品識別子。内部DynamoDB/AppSync
 * の`id`とも、BELLO自身が発番する`sku`とも異なる、第3の概念
 * （旧ZAICOデータとの継続性を最優先した在庫ID/エクスポート形式の
 * 再設計）:
 *
 * - 内部DB id（Amplify Dataの`id`） — GraphQLの主キー。ユーザー向け
 *   の在庫IDとしては絶対に使わない（URLの/inventory/[id]では使うが、
 *   画面上のラベルとしては一切表示しない — 既存の設計をそのまま維持）。
 * - SKU（`Inventory.sku`） — BELLOが`generateInventorySku`
 *   （amplify/functions/generate-sku）で発番する内部管理番号
 *   （"B000001"等）。ZAICO由来かBELLO作成かに関わらず、すべての
 *   Inventoryが必ず持つ。ZAICO同期でも新規作成時に必ず発番される
 *   （lib/inventory/zaicoSync.ts、ZAICOの数値IDをSKUとして流用する
 *   ことは一切ない — 既存の設計をそのまま維持）。
 * - 表示用「在庫ID」（このファイルの`resolveDisplayInventoryId`） —
 *   ZAICOから同期した商品は、旧ZAICOの在庫IDをそのまま踏襲して表示
 *   する（`sourceInventoryId`）。BELLOで新規作成された商品は、SKU
 *   をそのまま在庫IDとして表示する。
 *
 * 完全な導出値であり、DBには一切保存しない — `sourceSystem` /
 * `sourceInventoryId` / `sku` はすべて既存schemaに元から存在する
 * フィールドなので、この機能のためのschema変更は不要。既存のZAICO同
 * 期・SKU発番ロジックも一切変更していない（データの再採番・移行は
 * 発生しない）。
 *
 * Not `server-only` — 純粋な導出ロジックのみで、Amplify/Data
 * アクセスは一切ない。クライアント側（一覧テーブル等）からも同じ
 * ロジックをimportできるようにするため。
 */
export interface DisplayIdSource {
  sourceSystem: string | null;
  sourceInventoryId: string | null;
  sku: string;
}

export function resolveDisplayInventoryId(record: DisplayIdSource): string {
  if (record.sourceSystem === "ZAICO" && record.sourceInventoryId) return record.sourceInventoryId;
  return record.sku;
}
