import { inventoryCategoryIds } from './categories';

/** Purchase price is the stored unit acquisition cost (imported freight is already included). */
export const INVENTORY_VALUE_VERSION = 2;
export const VALUE_GROUPS = [
  { key: 'repair', label: '補修待ち', color: '#b78243' },
  { key: 'photo', label: '撮影待ち', color: '#7889ae' },
  { key: 'listing', label: '出品待ち', color: '#58a49b' },
  { key: 'selling', label: '出品中', color: '#264e47' },
  { key: 'wholesale', label: '業者間', color: '#9b8ba5' },
] as const;
export interface ValueSource {
  id: string; sku?: string | null; name?: string | null;
  quantity?: number | null; purchasePrice?: number | null;
  categoryIds?: readonly (string | null)[] | null; categoryId?: string | null;
  saleEndDate?: string | null; deletedAt?: string | null;
}
export interface ValueIssue { id: string; sku: string; name: string; reason: string }
export interface ValueGroup { key: string; label: string; color: string; amount: number; quantity: number; count: number }
export interface InventoryValue {
  version: 2; asOf: string; total: number; quantity: number; count: number;
  groups: ValueGroup[]; other: { label: string; amount: number; quantity: number; count: number }[];
  issues: ValueIssue[]; issueCount: number; excluded: { label: string; amount: number; count: number }[];
  unpricedCount: number;
  month?: string; source?: string;
}
export type InventoryValueView = { status: 'ok'; value: InventoryValue } | { status: 'missing' | 'error' };

const soldCategories = new Set(['売り切れ', '発送完了', '出荷指示済', '出荷指示済み', '発送済み']);
const nonStockCategories = new Set(['事務所備品', '破棄', '廃棄', '無償提供']);
const pendingCategories = new Set(['入金待ち', '未入金', '売り切れ 未入金']);
const groupAliases:Record<string,string>={
  '補修待ち':'repair','保留':'repair','撮影待ち':'photo','出品待ち':'listing','五十嵐さん':'listing',
  '販売中':'selling','出品中':'selling','複数在庫未出品':'selling','業者間':'wholesale',
};
const keyForLabel=(name:string)=>groupAliases[name.replace(/\s/g,'')];

export function buildInventoryValue(rows: readonly ValueSource[], categories: readonly {id:string;name:string}[], asOf: string): InventoryValue {
  const masters = new Map(categories.map(c => [c.id,c.name]));
  const groups: ValueGroup[] = VALUE_GROUPS.map(g => ({...g, amount:0,quantity:0,count:0}));
  const excluded = new Map<string,{label:string;amount:number;count:number}>();
  const issues: ValueIssue[] = [];
  const seen = new Set<string>(); let unpricedCount = 0, issueCount = 0;
  // Keep the read model bounded even when source data is incomplete on a large import.
  const issue = (r:ValueSource,reason:string) => {issueCount++;if(issues.length<50) issues.push({id:r.id,sku:r.sku??'',name:(r.name??'').slice(0,300),reason});};
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error('在庫IDが重複しています');
    seen.add(row.id);
    if (row.deletedAt) continue;
    const labels = inventoryCategoryIds(row).map(id=>masters.get(id)??'不明なカテゴリ');
    const mappedKeys=[...new Set(labels.map(keyForLabel).filter(Boolean))];
    // Wholesale is its own channel, even if the item also has a workflow category.
    const groupKey=mappedKeys.includes('wholesale')?'wholesale':groups.find(g=>mappedKeys.includes(g.key))?.key;
    const excludedLabel = labels.find(l=>nonStockCategories.has(l)) ??
      (labels.some(l=>pendingCategories.has(l))?'入金待ち':row.saleEndDate ? '販売終了日あり' : labels.find(l=>soldCategories.has(l))) ??
      (!groupKey?'集計区分なし':undefined);
    const quantity = row.quantity ?? 0;
    const validPrice = Number.isSafeInteger(row.purchasePrice) && row.purchasePrice! >= 0;
    const amount = validPrice && Number.isSafeInteger(quantity) && quantity>=0 ? row.purchasePrice!*quantity : 0;
    if (!Number.isSafeInteger(amount)) throw new Error('在庫金額が計算上限を超えています');
    if (excludedLabel) {
      const entry = excluded.get(excludedLabel)??{label:excludedLabel,amount:0,count:0};
      entry.amount+=amount; entry.count++; excluded.set(excludedLabel,entry);
      if (quantity>0 && row.saleEndDate && mappedKeys.length) issue(row,'作業カテゴリと販売終了日が併存しています。集計対象外です。');
      continue;
    }
    if (!Number.isSafeInteger(quantity)||quantity<0) {issue(row,'数量が不正のため集計できません');continue;}
    if (quantity===0) continue;
    const group = groups.find(g=>g.key===groupKey)!;
    if (mappedKeys.length>1&&groupKey!=='wholesale') issue(row,`作業カテゴリが複数あります。「${group.label}」に一度だけ計上しています。`);
    if (!validPrice) {unpricedCount++;issue(row,'購入単価が未入力または不正です。数量のみ計上しています。');}
    group.amount+=amount; group.quantity+=quantity; group.count++;
  }
  const total=groups.reduce((s,g)=>s+g.amount,0);
  if (!Number.isSafeInteger(total)) throw new Error('在庫金額が計算上限を超えています');
  return {version:2,asOf,total,quantity:groups.reduce((s,g)=>s+g.quantity,0),count:groups.reduce((s,g)=>s+g.count,0),groups,other:[],issues,issueCount,excluded:[...excluded.values()],unpricedCount};
}

/** Fail closed for malformed or old snapshots; never turn a failed calculation into ¥0. */
export function parseInventoryValue(json: string): InventoryValue {
  const v=JSON.parse(json) as InventoryValue;
  const integer=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
  if(v.version!==INVENTORY_VALUE_VERSION||!Number.isFinite(Date.parse(v.asOf))||!integer(v.total)||!integer(v.quantity)||!integer(v.count)||!integer(v.unpricedCount)||!integer(v.issueCount)||
    !Array.isArray(v.groups)||v.groups.length!==VALUE_GROUPS.length||v.groups.some((g,i)=>g.key!==VALUE_GROUPS[i].key||!integer(g.amount)||!integer(g.quantity)||!integer(g.count))||
    v.groups.reduce((s,g)=>s+g.amount,0)!==v.total||v.groups.reduce((s,g)=>s+g.quantity,0)!==v.quantity||v.groups.reduce((s,g)=>s+g.count,0)!==v.count||
    !Array.isArray(v.issues)||!Array.isArray(v.other)||!Array.isArray(v.excluded)) throw new Error('在庫集計を確認できません');
  return {...v,groups:v.groups.map((g,i)=>({...g,label:VALUE_GROUPS[i].label,color:VALUE_GROUPS[i].color}))};
}

export function donutSegments(groups: readonly ValueGroup[],metric:'amount'|'quantity'='amount') {
  const total=groups.reduce((s,g)=>s+g[metric],0);let offset=0;
  return groups.filter(g=>g[metric]>0).map(g=>{const length=total>0?g[metric]/total*100:0;const segment={...g,length,offset};offset+=length;return segment;});
}
