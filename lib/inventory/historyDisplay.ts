import type { InventoryHistoryRow } from "./queries";
import {inventoryFieldLabel} from './fieldLabel';
import {ALL_EXTENDED_FIELDS} from './extendedFields';
type HistoryContext={categories?:{id:string;name:string}[];locations?:{id:string;name:string}[];custom?:{fieldKey:string;label:string}[]};
const labels:Record<string,string>={quantity:'数量',name:'物品名',sourceQuantity:'移動元の数量',targetQuantity:'移動先の数量',remainingQuantity:'残り数量',splitQuantity:'分割した数量',movedQuantity:'移動数量',sentQuantity:'出庫数量',destination:'出庫先',locationId:'保管場所',sourceLocationId:'移動前の保管場所',categoryIds:'カテゴリ',sourceCategoryIds:'移動前のカテゴリ',classificationPreserved:'カテゴリ・場所を維持',movementCategoryRemoved:'移動予定カテゴリの解除',arrivalDate:'到着予定日',outboundName:'出庫時の名前'};
function parsed(value:string|null|undefined){if(!value)return null;try{const x=JSON.parse(value);return x&&typeof x==='object'?x:null;}catch{return null;}}
export function historyChangeDetails(h:Pick<InventoryHistoryRow,'fieldName'|'oldValue'|'newValue'>,context:HistoryContext={}){
 const before=parsed(h.oldValue),after=parsed(h.newValue);if(!before&&!after)return [];
 const flatten=(v:unknown,prefix=''):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))return {};const out:Record<string,unknown>={};for(const [key,value] of Object.entries(v)){
  if(key.startsWith('__')||/^(hash|id|.*Id|updatedAt|createdAt|revision|requestId|mutationId)$/i.test(key)&&!['locationId','sourceLocationId'].includes(key))continue;
  if(key==='result'&&value&&typeof value==='object'){Object.assign(out,flatten(value));continue;}
  if(labels[key]||ALL_EXTENDED_FIELDS.some(f=>f.key===key)||context.custom?.some(f=>f.fieldKey===key))out[prefix+key]=value;
 }return out;};
 const b=flatten(before),a=flatten(after);
 const render=(key:string,v:unknown):string=>{
  if(v===null||v===undefined||v==='')return '未設定';
  if(key.endsWith('CategoryIds')||key==='categoryIds')return Array.isArray(v)?v.map(id=>context.categories?.find(c=>c.id===id)?.name??'カテゴリ（記録詳細を参照）').join(' / ')||'なし':'記録詳細を参照';
  if(key==='locationId'||key==='sourceLocationId')return context.locations?.find(l=>l.id===v)?.name??'保管場所（記録詳細を参照）';
  if(typeof v==='boolean')return v?'はい':'いいえ';
  if(typeof v==='object')return Array.isArray(v)?v.map(String).join(' / '):'記録詳細を参照';return String(v);
 };
 return [...new Set([...Object.keys(b),...Object.keys(a)])].filter(k=>JSON.stringify(b[k])!==JSON.stringify(a[k])).map(k=>({label:labels[k]??inventoryFieldLabel(k,context.custom),before:render(k,b[k]),after:render(k,a[k])}));
}
export function historyActorLabel(value:string|null|undefined){return value&&/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)?'スタッフ':value||'システム';}
export function historyQuantity(h:Pick<InventoryHistoryRow,'fieldName'|'newValue'>):number|null{
 if(h.newValue===null||h.newValue===undefined||h.newValue.trim()==='')return null;
 const obj=parsed(h.newValue);const value=obj?obj.quantity??obj.remainingQuantity??obj.result?.remainingQuantity:h.fieldName.startsWith('数量')?Number(h.newValue):undefined;
 return typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
}

/**
 * 更新履歴テーブルの表示ヘルパー(P1 詳細遷移の待ち時間短縮 補正、
 * 2026-09-12)。
 *
 * 元々は InventoryHistoryTable.tsx(Server Component、初回SSR描画)一箇所
 * にしかなかったが、履歴取得の失敗を局所化する今回の修正で、同じ表を
 * クライアント側の再試行後にも描画する必要が出た
 * (InventoryHistorySection.tsx)——初回SSRと再試行後の2箇所が、同じ
 * テーブルを1文字も違わず描く必要があるので、ここだけは
 * 「1箇所の共有ヘルパーへ寄せる」側を選ぶ(このファイル自体の先頭コメ
 * ントで触れている「呼び出し元同士を結合させない」という repo 全体の
 * 既定方針そのものは変えていない——EditInventoryForm.tsx/
 * KnowledgeSettingsPanel.tsxのformatDateTimeのような無関係な機能同士を
 * 結合するのは避けつつ、同一機能・同一表を描く2つの入口だけを結ぶ)。
 *
 * `InventoryHistoryRow` は type-only import なので、tsx/esbuild的な
 * 型消去のもとではこのファイルの実行時import文には現れない——
 * queries.ts(server-only・Amplifyクライアントを持つ)を実際に読み込む
 * ことなく、このファイル単体を node/tsx で直接実行できる
 * (scripts/verify-inventory-history-resilience.ts 参照)。
 */

/** ISO datetime → "2026/08/28 17:40" — exact zero-padded format; Intl's dateStyle/timeStyle shorthand drops the leading zero on month/day/hour, which doesn't match. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "-";
  return new Intl.DateTimeFormat("ja-JP", {timeZone:"Asia/Tokyo",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(d);
}

/**
 * The history log (lib/inventory/history.ts) writes one row per changed
 * field, `fieldName` doing double duty as either an actual field label
 * ("商品名") or, for create/delete, the operation itself ("登録"/"削除")
 * — there's no separate stored "operation type" column. spec F wants a
 * ZAICO-style 日時/操作/変更内容/実行者 table, so these two helpers
 * derive that split from what's already stored rather than needing a
 * schema change.
 */
export function historyOperationLabel(fieldName: string): string {
  if (fieldName === "登録" || fieldName === "削除") return fieldName;
  return "編集";
}

export function historyChangeSummary(h: Pick<InventoryHistoryRow, "fieldName" | "oldValue" | "newValue">): string {
  if (h.fieldName === "登録" || h.fieldName === "削除") return h.newValue ?? h.oldValue ?? "-";
  return `${h.fieldName} ${h.oldValue ?? "-"} → ${h.newValue ?? "-"}`;
}
