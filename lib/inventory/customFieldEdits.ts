import {internalInventoryField} from './humanEdits';
export type CustomFieldValue = string | number | null;
export interface InlineCustomDefinition {fieldKey:string;label:string;fieldType:string;required:boolean;options:readonly string[];isActive?:boolean}
export function validateCustomPatchShape(value:unknown):asserts value is Record<string,CustomFieldValue> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>100)throw Error('追加項目を確認してください。');
  for(const [field,v] of Object.entries(value)) {
    if(!field||field.length>128||internalInventoryField(field)||['__proto__','constructor','prototype'].includes(field))throw Error('編集できない追加項目です。');
    if(v!==null&&(typeof v!=='string'&&typeof v!=='number'||typeof v==='number'&&!Number.isFinite(v)||typeof v==='string'&&v.length>100000))throw Error('追加項目の入力を確認してください。');
  }
}
export function validateCustomFieldChanges(value:unknown,defs:readonly InlineCustomDefinition[]):void {
  validateCustomPatchShape(value);
  for(const [field,v] of Object.entries(value)) {
    const def=defs.find(d=>d.fieldKey===field&&d.isActive!==false);
    if(!def)throw Error('編集できない追加項目です。');
    if(v===null||v===''){if(def.required)throw Error(`${def.label}は必須です。`);continue;}
    if(def.fieldType==='NUMBER') {if(typeof v!=='number'||!Number.isFinite(v))throw Error(`${def.label}は数値で入力してください。`);}
    else if(typeof v!=='string'||def.fieldType==='DATE'&&(!/^\d{4}-\d{2}-\d{2}$/.test(v)||Number.isNaN(Date.parse(v))||new Date(v).toISOString().slice(0,10)!==v)||def.fieldType==='SELECT'&&!def.options.includes(v))throw Error(`${def.label}の入力を確認してください。`);
  }
}
