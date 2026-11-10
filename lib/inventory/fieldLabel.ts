import {ALL_EXTENDED_FIELDS} from "./extendedFields";
const basic:Record<string,string>={name:"物品名",sku:"管理番号",quantity:"数量",unit:"単位",categoryIds:"カテゴリ",locationId:"保管場所",statusId:"状態",purchasePrice:"購入価格",salePrice:"販売価格",note:"備考",images:"画像"};
export function inventoryFieldLabel(field:string,custom:readonly {fieldKey:string;label:string}[]=[]):string {
  const key=field.startsWith("customFields.")?field.slice(13):field.startsWith("cf:")?field.slice(3):null;
  return key ? custom.find(d=>d.fieldKey===key)?.label ?? "追加項目："+key :
    basic[field] ?? ALL_EXTENDED_FIELDS.find(d=>d.key===field)?.label ?? field;
}
