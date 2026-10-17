import { buildSearchFieldDefs, evaluateQuery, isConditionComplete, operatorsForType, operatorNeedsNoValue, operatorNeedsSecondValue, type AdvancedSearchQuery, type SearchFieldDef } from "../../../lib/inventory/advancedSearch";
import { DEFAULT_INVENTORY_SORT, inventoryComparator, type InventorySort } from "../../../lib/inventory/searchSort";
import { DETAIL_FIELDS, validCalendarDate } from "./detailFields";
import type { MobileFeatures } from "./access";
import type { InventoryItem } from "./inventory";
export { DEFAULT_INVENTORY_SORT };
export type { InventorySort, AdvancedSearchQuery, SearchFieldDef };
export interface InventorySearchInput { q?: string; category?: string; offset?: number; advanced?: AdvancedSearchQuery; sort?: InventorySort }

/** The same field catalogue and feature boundaries as the existing BELLO editor. */
export function mobileSearchFields(fields: SearchFieldDef[], features: MobileFeatures): SearchFieldDef[] {
  const result = [...fields];
  for (const field of DETAIL_FIELDS) {
    const key = field.custom ? `cf:${field.key}` : field.key;
    if (!result.some(def => def.key === key)) result.push({key,label:field.label,group:field.section,valueType:field.kind === "date" ? "date" : field.kind === "money" || field.kind === "integer" ? "number" : "string"});
  }
  return result.filter(def => !DETAIL_FIELDS.some(field => field.feature && !features[field.feature] && (def.key === field.key || def.key === `cf:${field.key}`)))
    .map(def => ({...def, label: def.key === "name" ? "物品名" : def.key === "barcode" ? "QRコード・バーコードの値" : def.label}));
}
export function cachedSearchFields(items: InventoryItem[], features: MobileFeatures): SearchFieldDef[] {
  const names = (key: "category" | "location") => [...new Set(items.map(item => item[key]).filter(Boolean))].map(name=>({id:name,name}));
  return mobileSearchFields(buildSearchFieldDefs([], {categories:names("category"),locations:names("location"),statuses:[...new Map(items.map(item=>[item.statusId ?? item.condition,{id:item.statusId ?? item.condition,label:item.condition}])).values()]}),features);
}
export function searchValidation(query: AdvancedSearchQuery, fields: SearchFieldDef[]): string | null {
  if (!query || !["AND","OR"].includes(query.combinator) || !Array.isArray(query.conditions) || query.conditions.length > 20) return "検索条件は20件まで指定できます。";
  for (const condition of query.conditions) {
    if (!condition || typeof condition.field !== "string") return "検索項目を選択してください。";
    const field = fields.find(def=>def.key===condition.field);
    if (!field || !operatorsForType(field.valueType).some(op=>op.value===condition.operator)) return "この検索項目は利用できません。";
    if (![condition.value,condition.value2].every(value=>value===undefined||(typeof value==="string"&&value.length<=500))) return "検索する値を確認してください。";
    if (!isConditionComplete(condition)) return `${field.label}の条件を入力してください。`;
    if (operatorNeedsNoValue(condition.operator)) continue;
    const values = operatorNeedsSecondValue(condition.operator) ? [condition.value!,condition.value2!] : [condition.value!];
    if (field.valueType === "number" && values.some(value=>!Number.isFinite(Number(value)))) return `${field.label}は数字で入力してください。`;
    if (["date","datetime"].includes(field.valueType) && values.some(value=>!/^\d{4}-\d{2}-\d{2}$/.test(value)||!validCalendarDate(value))) return `${field.label}の日付を確認してください。`;
    if (field.options && !field.options.some(option=>option.value===condition.value)) return `${field.label}の選択肢を確認してください。`;
  }
  return null;
}

export function cachedInventorySearch(items: InventoryItem[], input: InventorySearchInput, fields: SearchFieldDef[]): InventoryItem[] {
  const defs = new Map(fields.map(field=>[field.key,field]));
  const mapMaster = (key:string,label:string) => defs.get(key)?.options?.find(option=>option.label===label)?.value ?? label;
  const records = items.map(item=>({item,record:{...item,...item.details,customFields:item.details ?? {},
    categoryId:mapMaster("categoryId",item.category),locationId:mapMaster("locationId",item.location),statusId:item.statusId ?? mapMaster("statusId",item.condition)}}));
  const compare=inventoryComparator(input.sort ?? DEFAULT_INVENTORY_SORT,defs);
  return records.filter(({item,record})=>{
    if (input.category && item.category!==input.category) return false;
    if (input.q && !`${item.name} ${item.sku} ${item.displayId ?? ""} ${item.barcode}`.toLocaleLowerCase().includes(input.q.toLocaleLowerCase().trim())) return false;
    if (!input.advanced?.conditions.length) return true;
    // Unfetched details are unknown, never misreported as empty fields.
    const results = input.advanced.conditions.map(condition=>{
      const key=condition.field.startsWith("cf:")?condition.field.slice(3):condition.field;
      if (!(condition.field in record) && !item.detailLoadedAt && !(key in (item.details ?? {}))) return false;
      if (condition.field.startsWith("cf:") && !DETAIL_FIELDS.some(field=>field.custom && field.key===key) && !(key in (item.details ?? {}))) return false;
      return evaluateQuery(record,{combinator:"AND",conditions:[condition]},defs);
    });
    return input.advanced.combinator === "OR" ? results.some(Boolean) : results.every(Boolean);
  }).sort((a,b)=>compare(a.record,b.record)).map(row=>row.item);
}
