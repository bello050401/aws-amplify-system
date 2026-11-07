import {createHash} from 'node:crypto';
import {FIELD_MAP,AXIS_LABELS,type ExtractionResult} from './types';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
export const META='__belloSupplierExtraction';
export function customObject(raw:unknown):Record<string,unknown>{try{const v=typeof raw==='string'?JSON.parse(raw):raw;return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch{return {};}}
type AppliedField={value:string;sourceKey:string;hash:string};
/** Pure plan. Adapter must CAS the inventory version and current extraction
 * revision in ONE transaction when applying this patch. */
export function planSupplierMerge(inventory:Record<string,unknown>,result:ExtractionResult,sourceKey:string){
 const custom=customObject(inventory.customFields),previous=customObject(custom[META]),fields={...customObject(previous.fields)} as Record<string,AppliedField>,patch:Record<string,unknown>={},held:string[]=[];
 const human=new Set(Array.isArray(custom.__belloEditedFields)?custom.__belloEditedFields:[]);
 if(!result.source.complete||!result.source.targetVerified)return{patch:{},held:['対象商品または資料の取得が未確定です'],applied:[],custom};
 const applied:string[]=[];
 for(const field of Object.keys(FIELD_MAP)){
  const choices=result.dimensions.filter(d=>d.axis===field&&d.disposition==='ACCEPT'&&d.mm!==null);
  if(!choices.length)continue;
  const value=String(Number((choices[0].mm!/10).toFixed(6))),current=String(inventory[field]??'');
  if(new Set(choices.map(d=>d.mm)).size>1){held.push(field+'：記載値が競合しています');continue;}
  if(human.has(field)||current&&!(fields[field]?.sourceKey===sourceKey&&fields[field]?.value===current)){
   held.push(field+'：スタッフの入力または別資料の値を保持しました');continue;
  }
  if(current!==value)patch[field]=value;
  fields[field]={value,sourceKey,hash:result.source.hash};applied.push(field);
 }
 if(result.source.identity.provider==='RESTAGE'){
  const dim=result.dimensions.filter(d=>d.disposition==='ACCEPT').map(d=>`${AXIS_LABELS[d.axis]}：${d.raw.trim()}${d.unit&&!/\b(?:mm|cm|m)\b/i.test(d.raw)?' '+d.unit:''}${d.condition?'（'+d.condition+'）':''}`);
  const defects=result.defects.filter(d=>d.disposition==='ACCEPT').map(d=>d.text);
  const remarks=(result.remarks||[]).filter(r=>r.disposition==='ACCEPT').map(r=>r.text);
  if(dim.length||defects.length||remarks.length){
   const marker='【仕入先記載／リステージ】',end='【仕入先記載ここまで】';
   const body=[marker,...new Set(dim),...new Set(defects),...(remarks.length?['備考・特記事項（原文）',...remarks]:[]),end].join('\n'),note=String(inventory.note??'');
   const old=previous.note as {sourceKey:string;body:string;hash:string}|undefined;
   if(old&&human.has('note'))held.push('備考：スタッフが確認・確定した記載を保持しました');
   else if(old&&old.sourceKey===sourceKey&&digest(old.body)===old.hash&&note.split(old.body).length===2){patch.note=note.replace(old.body,body);}
   else if(!old&&!note.includes(marker)){patch.note=(note?note+'\n\n':'')+body;}
   else held.push('備考：自動取込部分が編集されているため保持しました');
   if(patch.note!==undefined){custom[META]={...previous,note:{sourceKey,body,hash:digest(body)}};applied.push('note');if(patch.note===note)delete patch.note;}
  }
 }
 custom[META]={...previous,...customObject(custom[META]),fields,lastSourceKey:sourceKey,lastHash:result.source.hash,version:result.version,provenance:'仕入先記載・自社検品未確定'};
 return {patch,held,applied,custom};
}
