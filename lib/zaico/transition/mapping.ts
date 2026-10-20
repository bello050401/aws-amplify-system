import {mapZaicoCoreFields,mapZaicoOptionalAttributes,resolveZaicoAttributeTarget,ZAICO_ATTRIBUTE_MAP} from '../../inventory/zaicoMapping';
import {parseCustomFields} from '../../inventory/zaicoSyncEngine';
import {inventoryCategoryIds,splitCategoryNames} from '../../inventory/categories';
import {type V2Inventory,toLegacyInventory} from './v2Client';
import type {SharedFields} from './protocol';
import {RAW_VALUES} from './rawValues';

export {RAW_VALUES} from './rawValues';
// DynamoDB records include the existing dynamic custom-field schema. Shared
// values are validated and projected by remoteFields/localFields below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row=Record<string,any>;
export interface Masters {
  categories:Row[]; locations:Row[]; statuses:Row[];
  attributeNames?:string[];
  resolve:(kind:'Category'|'Location'|'StatusMaster',name:string)=>Promise<string>;
}
const optionalTargets=new Map<string,{name:string;kind:'coreField'|'extendedField'|'customField';field:string}>();
for(const [name,target] of Object.entries(ZAICO_ATTRIBUTE_MAP)){
  if(target.kind==='unmapped'||(target.kind==='coreField'&&target.lowerPriority))continue;
  const field=target.kind==='customField'?`custom.${target.fieldKey}`:target.field;
  if(!optionalTargets.has(field))optionalTargets.set(field,{name,kind:target.kind,field});
}
export const SHARED_FIELDS=['name','quantity','unit','categoryIds','locationId','statusId','note','barcode',...optionalTargets.keys()];

/** Only genuinely shared fields participate. Listing settings and photo batches remain BELLO-owned. */
export function localFields(row:Row):SharedFields {
  const custom=parseCustomFields(row.customFields)??{};
  return Object.fromEntries(SHARED_FIELDS.map(field=>[field,field==='categoryIds'?inventoryCategoryIds(row).sort():
    field.startsWith('custom.')?custom[field.slice(7)]??null:row[field]??null])) as SharedFields;
}

/**
 * Preserve unrepresentable source values verbatim. They are NOT converted into
 * fabricated numbers/dates and are NEVER echoed back as a blank by a no-op save.
 */
export async function remoteFields(remote:V2Inventory,masters:Masters){
  const legacy=toLegacyInventory(remote);
  const mappedCore=mapZaicoCoreFields(legacy),core=mappedCore.fields;
  const coreWarnings=mappedCore.warnings.filter(w=>!w.startsWith('titleが空'));
  if(coreWarnings.length)throw Error(coreWarnings.join(' / '));
  if(core.quantity!==null&&(!Number.isSafeInteger(core.quantity)||Number(core.quantity)<0))throw Error('ZAICO数量は整数である必要があります。');
  const fields=Object.fromEntries(SHARED_FIELDS.map(f=>[f,null])) as SharedFields;
  Object.assign(fields,{name:remote.title??'',quantity:core.quantity,unit:core.unit??null,note:core.note??null,barcode:core.barcode??null,
    categoryIds:await Promise.all(splitCategoryNames(remote.category??'').map(n=>masters.resolve('Category',n))),
    locationId:remote.place?.trim()?await masters.resolve('Location',remote.place.trim()):null,
    statusId:remote.state?.trim()?await masters.resolve('StatusMaster',remote.state.trim()):null});
  (fields.categoryIds as string[]).sort();
  const raw:Record<string,{name:string;value:string}>={};
  const attributes=legacy.optional_attributes??[];
  // The existing central mapper resolves aliases, unknown fields and precedence.
  const normalized=attributes.map(a=>{
    const target=resolveZaicoAttributeTarget(a.name);
    return target.kind!=='unmapped'&&target.valueType==='number'&&typeof a.value==='string'
      ?{...a,value:a.value.normalize('NFKC')}:a;
  });
  const mapped=mapZaicoOptionalAttributes(normalized,true);
  Object.assign(fields,mapped.coreFields,mapped.extendedFields);
  for(const [key,value] of Object.entries(mapped.customFields))fields[`custom.${key}`]=value as SharedFields[string];
  for(const attribute of normalized){
    const target=resolveZaicoAttributeTarget(attribute.name);
    if(target.kind==='unmapped'||!attribute.value?.trim())continue;
    const one=mapZaicoOptionalAttributes([attribute],true);
    if(one.warnings.some(w=>/変換|解釈|不正/.test(w))){
      const field=target.kind==='customField'?`custom.${target.fieldKey}`:target.field;
      raw[field]={name:attribute.name,value:String(attributes.find(a=>a.name===attribute.name)?.value??attribute.value)};
    }
  }
  return {fields,raw};
}

export function applyFields(row:Row,fields:SharedFields,raw?:Record<string,unknown>):Row {
  const update:Row={id:row.id,updatedBy:'ZAICO暫定同期'};
  const custom={...parseCustomFields(row.customFields)};
  for(const [key,value] of Object.entries(fields)){
    if(key.startsWith('custom.'))custom[key.slice(7)]=value;
    else update[key]=value;
  }
  if(raw!==undefined)custom[RAW_VALUES]=raw;
  // Remote application is not an interactive edit; keep source baseline separate.
  update.customFields=JSON.stringify(custom);
  return update;
}

const masterName=(rows:Row[],id:unknown,label='name')=>{
  if(!id)return '';
  const hit=rows.find(r=>r.id===id);
  if(!hit)throw Error('同期するカテゴリ・保管場所・状態がマスタに見つかりません。');
  return String(hit[label]??'');
};
/** A fresh remote snapshot supplies unchanged optional fields; partial writes never drop them. */
export function outgoingPatch(changes:SharedFields,remote:V2Inventory|undefined,masters:Masters):Row {
  const patch:Row={};
  const direct:Record<string,string>={name:'title',quantity:'quantity',unit:'unit',note:'etc',barcode:'code'};
  // Responses permit null, but v2 update requests accept string values only.
  // Keep every existing field, representing an empty source value as "".
  const optional=Object.fromEntries(Object.entries(remote?.optional_attributes??{}).map(([name,value])=>[name,value??'']));
  let optionalChanged=false;
  for(const [field,value] of Object.entries(changes)){
    if(field in direct)patch[direct[field]]=value===null?'':String(value);
    else if(field==='categoryIds')patch.category=(value as string[]).map(id=>masterName(masters.categories,id)).join(',');
    else if(field==='locationId')patch.place=masterName(masters.locations,value);
    else if(field==='statusId')patch.state=masterName(masters.statuses,value,'label');
    else {
      if(!remote&&value===null)continue; // New items do not need blank optional fields sent.
      const target=optionalTargets.get(field);
      if(!target)throw Error(`同期未対応の項目です: ${field}`);
      // Update every alias already present, otherwise the canonical source name.
      const matches=(name:string)=>{
        const t=resolveZaicoAttributeTarget(name);
        return t.kind!=='unmapped'&&(t.kind==='customField'?`custom.${t.fieldKey}`:t.field)===field;
      };
      const existing=Object.keys(optional).filter(matches);
      const observed=(masters.attributeNames??[]).filter(matches);
      const names=existing.length?existing:observed.length?observed:[target.name];
      for(const name of names)optional[name]=value===null?'':String(value);
      optionalChanged=true;
    }
  }
  if(optionalChanged)patch.optional_attributes=optional;
  return patch;
}
