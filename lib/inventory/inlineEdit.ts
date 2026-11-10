import { ALL_EXTENDED_FIELDS } from './extendedFields';
import { internalInventoryField } from './humanEdits';
import { validateName, validateCategoryArray } from './editTransform';
import { inventoryQuantityError } from './quantityValidation';

export const INLINE_EDIT_FIELDS = {
  name:{inputType:'text'}, quantity:{inputType:'number'},
  category:{inputType:'select-category'}, location:{inputType:'select-location'},
  unit:{inputType:'text'}, barcode:{inputType:'text'},
  plannedSalePrice:{inputType:'number'}, salePrice:{inputType:'number'}, purchasePrice:{inputType:'number'},
  saleCommission:{inputType:'number'}, market:{inputType:'text'}, note:{inputType:'textarea'},
  width:{inputType:'text'}, depth:{inputType:'text'}, height:{inputType:'text'},
  saleStartDate:{inputType:'date'}, saleEndDate:{inputType:'date'}, transactionDate:{inputType:'date'},
  transactionType:{inputType:'text'}, adminMemo:{inputType:'textarea'},
  conditionRating:{inputType:'textarea'}, damageNotes:{inputType:'textarea'},
} as const;
export type StaticInlineEditFieldKey = keyof typeof INLINE_EDIT_FIELDS;
export type InlineEditFieldKey = StaticInlineEditFieldKey | `cf:${string}`;
export type CustomFieldValue = string | number | null;
export type InlineEditChanges = {
  name?:string; quantity?:number|null; locationId?:string|null; categoryIds?:string[];
  plannedSalePrice?:number|null; salePrice?:number|null; purchasePrice?:number|null; saleCommission?:number|null;
  unit?:string|null; barcode?:string|null; market?:string|null; note?:string|null;
  width?:string|null; depth?:string|null; height?:string|null;
  saleStartDate?:string|null; saleEndDate?:string|null; transactionDate?:string|null;
  transactionType?:string|null; adminMemo?:string|null; conditionRating?:string|null; damageNotes?:string|null;
  /** A patch only. Never replace the complete customFields object or internal metadata. */
  customFieldChanges?:Record<string,CustomFieldValue>;
};
export interface InlineCustomDefinition {fieldKey:string;label:string;fieldType:string;required:boolean;options:readonly string[];isActive?:boolean}
export function isInlineEditableColumn(key:string,defs:readonly InlineCustomDefinition[]=[]):key is InlineEditFieldKey {
  return Object.hasOwn(INLINE_EDIT_FIELDS,key) || key.startsWith('cf:') && !internalInventoryField(key.slice(3)) && defs.some(d=>d.fieldKey===key.slice(3)&&d.isActive!==false);
}
export function inlineFieldKey(column:StaticInlineEditFieldKey):Exclude<keyof InlineEditChanges,'customFieldChanges'> {
  return column==='category'?'categoryIds':column==='location'?'locationId':column;
}
const validDate=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
/** Same whitelist/type checks for every directly editable cell; evaluated on the server too. */
export function validateInlineChanges(changes:InlineEditChanges,defs:readonly InlineCustomDefinition[]=[]):void {
  if(!changes||typeof changes!=='object'||Array.isArray(changes))throw Error('入力内容を確認してください。');
  const fields=new Map(Object.keys(INLINE_EDIT_FIELDS).map(c=>[inlineFieldKey(c as StaticInlineEditFieldKey),c as StaticInlineEditFieldKey]));
  for(const [key,value] of Object.entries(changes)) {
    if(key==='customFieldChanges') {
      if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>100)throw Error('追加項目を確認してください。');
      for(const [field,v] of Object.entries(value)) {
        const def=defs.find(d=>d.fieldKey===field&&d.isActive!==false);
        if(!def||internalInventoryField(field)||['__proto__','constructor','prototype'].includes(field))throw Error('編集できない追加項目です。');
        if(v===null||v===''){if(def.required)throw Error(`${def.label}は必須です。`);continue;}
        if(def.fieldType==='NUMBER') {if(typeof v!=='number'||!Number.isFinite(v))throw Error(`${def.label}は数値で入力してください。`);}
        else if(typeof v!=='string'||v.length>100000||def.fieldType==='DATE'&&!validDate(v)||def.fieldType==='SELECT'&&!def.options.includes(v))throw Error(`${def.label}の入力を確認してください。`);
      }
      continue;
    }
    const column=fields.get(key as Exclude<keyof InlineEditChanges,'customFieldChanges'>);
    if(!column)throw Error('一覧から編集できない項目です。');
    if(column==='name'){validateName(value);continue;}
    if(column==='category'){validateCategoryArray(value);continue;}
    if(column==='quantity'){
      if(value!==null&&typeof value!=='number')throw Error('数量は数値で入力してください。');
      const error=inventoryQuantityError(value);if(error)throw Error(error);continue;
    }
    if(value===null)continue;
    const type=INLINE_EDIT_FIELDS[column].inputType;
    if(type==='number'){if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw Error('金額は0以上の数値で入力してください。');}
    else if(typeof value!=='string'||value.length>100000||type==='date'&&!validDate(value))throw Error('入力内容を確認してください。');
    const extended=ALL_EXTENDED_FIELDS.find(d=>d.key===column);
    if(extended?.type==='select'&&typeof value==='string'&&value&&!extended.options?.some(o=>o.value===value))throw Error(`${extended.label}の選択肢を確認してください。`);
  }
}
export const INLINE_EDIT_HISTORY_SUFFIX = '（一覧直接編集）';
