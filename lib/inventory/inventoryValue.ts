import { inventoryCategoryIds } from './categories';

/** Purchase price is the stored unit acquisition cost (imported freight is already included). */
export const INVENTORY_VALUE_VERSION = 1;
export const VALUE_GROUPS = [
  { key: 'repair', label: '補修待ち', color: '#b78243' },
  { key: 'photo', label: '撮影待ち', color: '#7889ae' },
  { key: 'listing', label: '出品待ち', color: '#58a49b' },
  { key: 'selling', label: '販売中', color: '#264e47' },
  { key: 'other', label: 'その他の在庫', color: '#a3aba6' },
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
  version: 1; asOf: string; total: number; quantity: number; count: number;
  groups: ValueGroup[]; other: { label: string; amount: number; quantity: number; count: number }[];
  issues: ValueIssue[]; issueCount: number; excluded: { label: string; amount: number; count: number }[];
  unpricedCount: number;
  month?: string; source?: string;
}
export type InventoryValueView = { status: 'ok'; value: InventoryValue } | { status: 'missing' | 'error' };

const soldCategories = new Set(['売り切れ', '発送完了', '出荷指示済', '出荷指示済み', '発送済み']);
const nonStockCategories = new Set(['事務所備品', '破棄', '廃棄', '無償提供']);
const pendingCategories = new Set(['入金待ち', '未入金', '売り切れ 未入金']);

export function buildInventoryValue(rows: readonly ValueSource[], categories: readonly {id:string;name:string}[], asOf: string): InventoryValue {
  const masters = new Map(categories.map(c => [c.id,c.name]));
  const groups: ValueGroup[] = VALUE_GROUPS.map(g => ({...g, amount:0,quantity:0,count:0}));
  const other = new Map<string,{label:string;amount:number;quantity:number;count:number}>();
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
    const pending = labels.some(l=>pendingCategories.has(l));
    const excludedLabel = labels.find(l=>nonStockCategories.has(l)) ??
      (row.saleEndDate ? '販売終了日あり' : !pending ? labels.find(l=>soldCategories.has(l)) : undefined);
    const quantity = row.quantity ?? 0;
    const validPrice = Number.isSafeInteger(row.purchasePrice) && row.purchasePrice! >= 0;
    const amount = validPrice && Number.isSafeInteger(quantity) && quantity>=0 ? row.purchasePrice!*quantity : 0;
    if (!Number.isSafeInteger(amount)) throw new Error('在庫金額が計算上限を超えています');
    if (excludedLabel) {
      const entry = excluded.get(excludedLabel)??{label:excludedLabel,amount:0,count:0};
      entry.amount+=amount; entry.count++; excluded.set(excludedLabel,entry);
      if (quantity>0 && row.saleEndDate && labels.some(l=>VALUE_GROUPS.some(g=>g.label===l))) issue(row,'作業カテゴリと販売終了日が併存しています。集計対象外です。');
      continue;
    }
    if (!Number.isSafeInteger(quantity)||quantity<0) {issue(row,'数量が不正のため集計できません');continue;}
    if (quantity===0) continue;
    const matches = pending ? [] : groups.filter(g=>g.key!=='other'&&labels.includes(g.label));
    const group = matches.length===1 ? matches[0] : groups[4];
    if (matches.length>1) issue(row,'作業カテゴリが複数あります。「その他」に一度だけ計上しています。');
    if (!validPrice) {unpricedCount++;issue(row,'購入単価が未入力または不正です。数量のみ計上しています。');}
    group.amount+=amount; group.quantity+=quantity; group.count++;
    if (group.key==='other') {
      const label = pending?'入金待ち':matches.length>1?'作業カテゴリ重複':labels.filter(l=>!l.endsWith('移動予定')&&!l.endsWith('確認')).sort().join('・')||'カテゴリ未設定';
      const entry=other.get(label)??{label,amount:0,quantity:0,count:0};
      entry.amount+=amount;entry.quantity+=quantity;entry.count++;other.set(label,entry);
    }
  }
  const total=groups.reduce((s,g)=>s+g.amount,0);
  if (!Number.isSafeInteger(total)) throw new Error('在庫金額が計算上限を超えています');
  return {version:1,asOf,total,quantity:groups.reduce((s,g)=>s+g.quantity,0),count:groups.reduce((s,g)=>s+g.count,0),groups,other:[...other.values()].sort((a,b)=>b.amount-a.amount),issues,issueCount,excluded:[...excluded.values()],unpricedCount};
}

/** Fail closed for malformed or old snapshots; never turn a failed calculation into ¥0. */
export function parseInventoryValue(json: string): InventoryValue {
  const v=JSON.parse(json) as InventoryValue;
  const integer=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
  if(v.version!==1||!Number.isFinite(Date.parse(v.asOf))||!integer(v.total)||!integer(v.quantity)||!integer(v.count)||!integer(v.unpricedCount)||!integer(v.issueCount)||
    !Array.isArray(v.groups)||v.groups.length!==VALUE_GROUPS.length||v.groups.some((g,i)=>g.key!==VALUE_GROUPS[i].key||!integer(g.amount)||!integer(g.quantity)||!integer(g.count))||
    v.groups.reduce((s,g)=>s+g.amount,0)!==v.total||v.groups.reduce((s,g)=>s+g.quantity,0)!==v.quantity||v.groups.reduce((s,g)=>s+g.count,0)!==v.count||
    !Array.isArray(v.issues)||!Array.isArray(v.other)||!Array.isArray(v.excluded)) throw new Error('在庫集計を確認できません');
  return {...v,groups:v.groups.map((g,i)=>({...g,label:VALUE_GROUPS[i].label,color:VALUE_GROUPS[i].color}))};
}

/** Read from the supplied workbook, monthly M22. Blank cells are intentionally absent. */
export const INVENTORY_VALUE_REFERENCES = [
  ['2026-01',6711234],['2026-02',7363395],['2026-03',9484320],['2026-04',9525084],
  ['2026-05',9983077],['2026-06',9152186],['2026-07',10807872],['2026-08',10051277],['2026-09',11516163],
] as const;
export const VALUE_REFERENCE_NOTE = '月末金額は、保存された当時の在庫情報から集計します。現在の数量が変わっても過去月末の集計は変えません。売上表に比較金額がある月だけ、同じ月の差額を表示します。';
export const VALUE_BASIS_NOTE = '購入単価 × 集計時点の数量。仕入時に単価へ含めた送料は二重加算しません。入金待ちは在庫に含み、販売終了・発送完了・売り切れ・事務所備品・破棄・無償提供は対象外です。移動予定などの補助カテゴリで重複計上しません。';

export function donutSegments(groups: readonly ValueGroup[]) {
  const total=groups.reduce((s,g)=>s+g.amount,0);let offset=0;
  return groups.filter(g=>g.amount>0).map(g=>{const length=total>0?g.amount/total*100:0;const segment={...g,length,offset};offset+=length;return segment;});
}
