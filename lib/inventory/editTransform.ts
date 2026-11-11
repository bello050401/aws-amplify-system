import {managedStockTitleChange} from './managedStockTitle';
import {validateName,validateCategoryArray,InventoryEditValidationError,INVENTORY_NAME_LIMIT} from './editValidation';
export {validateName,validateCategoryArray,InventoryEditValidationError,INVENTORY_NAME_LIMIT,CATEGORY_LIMIT} from './editValidation';
import {validateInlineChanges,type InlineEditChanges} from './inlineEdit';
const invalid=(message:string):never=>{throw new InventoryEditValidationError('INVALID',message);};
/** Shared pure preview and validation. Category names are never identifiers. */
import {validateCustomPatchShape,type CustomFieldValue} from './customFieldEdits';
import {parseCustomFields} from './customFieldsCodecCore';
export type CategoryOperation = { mode:'keep' } | { mode:'modify'; add:string[]; remove:string[] } | { mode:'replace'; ids:string[] } | { mode:'clear' };
export const BRACKETS = { wide:['（','）'], narrow:['(',')'], memo:['【','】'] } as const;
export type BracketKind = keyof typeof BRACKETS;
export type NameRule = { kind:'prefix'; text:string; skipExisting:boolean } | { kind:'remove'; text:string } | { kind:'replace'; from:string; to:string } | { kind:'brackets'; bracket:BracketKind; content:boolean } | { kind:'convert'; from:BracketKind; to:BracketKind };
export interface InventoryEditRules { categories:CategoryOperation; names:NameRule[]; location?: {mode:"keep"|"clear"} | {mode:"set";id:string}; customFieldChanges?:Record<string,CustomFieldValue>; fields?:Omit<InlineEditChanges,"name"|"categoryIds"|"locationId"|"customFieldChanges"> }
export function validateEditRules(value:unknown):asserts value is InventoryEditRules {
  const r=value as InventoryEditRules;
  if(!r||!r.categories||!Array.isArray(r.names)||r.names.length>30)invalid('編集内容を確認してください。');
  if(r.fields!==undefined){if(!r.fields||typeof r.fields!=="object"||["name","categoryIds","locationId","customFieldChanges"].some(k=>Object.hasOwn(r.fields!,k)))invalid("項目別の操作を使用してください。");validateInlineChanges(r.fields);}
  if(r.customFieldChanges!==undefined)validateCustomPatchShape(r.customFieldChanges);
  if(r.location && (!["keep","clear","set"].includes(r.location.mode) ||
    r.location.mode === "set" && (typeof r.location.id !== "string" || !r.location.id || r.location.id.length > 128)))invalid("保管場所を選択してください。");
  const c=r.categories;
  const allowedKeys=c.mode==='modify'?['mode','add','remove']:c.mode==='replace'?['mode','ids']:['mode'];
  if(Object.keys(c).some(key=>!allowedKeys.includes(key)))invalid('追加・解除と、置換・全解除は併用できません。');
  if(c.mode==='modify'){validateCategoryArray(c.add);validateCategoryArray(c.remove);if(c.add.some(id=>c.remove.includes(id)))invalid('同じカテゴリを追加と解除の両方に指定できません。');}
  else if(c.mode==='replace'){validateCategoryArray(c.ids);if(!c.ids.length)invalid('すべて外す場合は「全解除」を選択してください。');}
  else if(c.mode!=='keep'&&c.mode!=='clear')invalid('カテゴリ操作が不正です。');
  const text=(s:unknown,empty=false)=>{if(typeof s!=='string'||(!empty&&s.length===0)||s.length>INVENTORY_NAME_LIMIT)invalid('加工する文字列を入力してください。');};
  const bracket=(b:unknown)=>{if(typeof b!=='string'||!Object.hasOwn(BRACKETS,b))invalid('括弧の種類を選択してください。');};
  for(const rule of r.names){
    if(!rule||typeof rule!=='object')invalid('物品名の操作が不正です。');
    switch(rule.kind){
      case 'prefix':text(rule.text);if(typeof rule.skipExisting!=='boolean')invalid('重複時の操作を確認してください。');break;
      case 'remove':text(rule.text);break;
      case 'replace':text(rule.from);text(rule.to,true);break;
      case 'brackets':bracket(rule.bracket);if(typeof rule.content!=='boolean')invalid('括弧の削除方法を確認してください。');break;
      case 'convert':bracket(rule.from);bracket(rule.to);break;
      default:invalid('物品名の操作が不正です。');
    }
  }
}
export function transformCategories(before:readonly string[],operation:CategoryOperation):string[]{
  const current=[...new Set(before)];
  switch(operation.mode){case 'keep':return current;case 'clear':return [];case 'replace':return [...new Set(operation.ids)];case 'modify':return [...new Set([...current,...operation.add])].filter(id=>!operation.remove.includes(id));}
}
interface Pair {start:number;end:number;kind:BracketKind}
export function parseBracketPairs(name:string):Pair[]{
  const pairs:Pair[]=[],stack:{start:number;kind:BracketKind}[]=[];
  for(let i=0;i<name.length;i++)for(const kind of Object.keys(BRACKETS) as BracketKind[]){
    const [open,close]=BRACKETS[kind];
    if(name[i]===open)stack.push({start:i,kind});
    if(name[i]===close){const top=stack.pop();if(!top||top.kind!==kind)throw new InventoryEditValidationError('BRACKETS','括弧を確認：閉じ忘れ、または対応しない括弧があります。');pairs.push({...top,end:i});}
  }
  if(stack.length)throw new InventoryEditValidationError('BRACKETS','括弧を確認：閉じ忘れがあります。');
  return pairs;
}
export function transformName(original:string,rules:readonly NameRule[]):string{
  let name=original;
  for(const rule of rules){
    if(rule.kind==='prefix')name=rule.skipExisting&&name.startsWith(rule.text)?name:rule.text+name;
    else if(rule.kind==='remove')name=name.split(rule.text).join('');
    else if(rule.kind==='replace')name=name.split(rule.from).join(rule.to);
    else{
      const kind=rule.kind==='convert'?rule.from:rule.bracket,pairs=parseBracketPairs(name).filter(p=>p.kind===kind);
      if(rule.kind==='brackets'&&rule.content){
        const ranges:Pair[]=[];
        for(const p of pairs.sort((a,b)=>a.start-b.start||b.end-a.end)){const last=ranges.at(-1);if(last&&p.start<=last.end)last.end=Math.max(last.end,p.end);else ranges.push({...p});}
        for(const p of ranges.reverse())name=name.slice(0,p.start)+name.slice(p.end+1);
      }else{
        const replacements=new Map<number,string>();
        for(const p of pairs){replacements.set(p.start,rule.kind==='convert'?BRACKETS[rule.to][0]:'');replacements.set(p.end,rule.kind==='convert'?BRACKETS[rule.to][1]:'');}
        name=name.split('').map((char,i)=>replacements.get(i)??char).join('');
      }
    }
  }
  validateName(name);return name;
}
export function transformInventoryEdit(before:{name:string;categoryIds:string[];locationId?:unknown;customFields?:unknown;[key:string]:unknown},rules:InventoryEditRules){
  validateEditRules(rules);
  const after=managedStockTitleChange({...rules.fields,name:transformName(before.name,rules.names),categoryIds:transformCategories(before.categoryIds,rules.categories),
    ...(rules.location?.mode === "set" ? {locationId:rules.location.id} : rules.location?.mode === "clear" ? {locationId:null} : {}),
    ...(rules.customFieldChanges&&Object.keys(rules.customFieldChanges).length ? {customFields:{...parseCustomFields(before.customFields),...rules.customFieldChanges}}:{})}, before);
  validateName(after.name);validateCategoryArray(after.categoryIds);
  return {before,after,changed:Object.entries(rules.fields??{}).some(([key,value])=>before[key]!==value)||before.name!==after.name||JSON.stringify(before.categoryIds)!==JSON.stringify(after.categoryIds)||
    "locationId" in after && before.locationId!==after.locationId || "customFields" in after && JSON.stringify(parseCustomFields(before.customFields))!==JSON.stringify(parseCustomFields(after.customFields))};
}
