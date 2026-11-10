import type { InventoryListRow } from "./queries";
import { productCustomFields } from "./humanEdits";

// Full search records also carry detail fields and sync/history metadata.
// Keep those on the server: the list needs exact editable values, not histories.
const fields = [
  "id","sku","displayId","sourceSystem","sourceInventoryId","name",
  "categoryId","categoryIds","statusId","locationId","quantity","quantityUnset","unit",
  "purchasePrice","salePrice","plannedSalePrice","note",
  "mainImageSignedUrl","mainImageStorageKey","mainImageThumbnailKey","mainImageIsPrimary","imageCount",
  "createdAt","updatedAt","revision","listUpdatedAt","barcode","saleCommission","market",
  "saleStartDate","saleEndDate","width","depth","height","conditionRating","damageNotes",
  "transactionDate","transactionType","adminMemo",
] as const satisfies readonly (keyof InventoryListRow)[];
type Missing = Exclude<keyof InventoryListRow,typeof fields[number] | "customFields">;
const exhaustive: Missing extends never ? true : never = true;
void exhaustive;

export function browserListRow(row: InventoryListRow): InventoryListRow {
  return {
    ...Object.fromEntries(fields.map(key=>[key,row[key]])),
    customFields: row.customFields ? productCustomFields(row.customFields) : null,
  } as InventoryListRow;
}
