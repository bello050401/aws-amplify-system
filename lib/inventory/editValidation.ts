export const INVENTORY_NAME_LIMIT = 2000;
export const CATEGORY_LIMIT = 20;
export class InventoryEditValidationError extends Error { constructor(readonly code:string,message:string){super(message);} }
const invalid=(message:string):never=>{throw new InventoryEditValidationError('INVALID',message);};
export function validateName(name:unknown):asserts name is string {
  if(typeof name!=='string'||!name.trim()||name.length>INVENTORY_NAME_LIMIT)invalid(`物品名は空白以外の文字を含む${INVENTORY_NAME_LIMIT}文字以内で入力してください。`);
}
export function validateCategoryArray(ids:unknown):asserts ids is string[] {
  if(!Array.isArray(ids)||ids.length>CATEGORY_LIMIT||ids.some(id=>typeof id!=='string'||!id||id.length>128))invalid(`カテゴリは${CATEGORY_LIMIT}個以内で選択してください。`);
}
