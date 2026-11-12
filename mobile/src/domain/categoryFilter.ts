import type {SearchFieldDef} from './search';

export interface CategoryChoice {value:string;label:string}
export const QUICK_CATEGORY_NAMES = ['補修待ち','撮影待ち','出品待ち','販売中','売り切れ','入金待ち'];

export function validCategoryChoices(value:unknown):value is CategoryChoice[] {
  return Array.isArray(value) && value.every(item=>item && typeof item.value==='string' && item.value.trim() && typeof item.label==='string' && item.label.trim()) &&
    new Set(value.map(item=>item.value)).size===value.length;
}

/** Preserve master IDs, including distinct categories that share a display name. */
export function withFilterCategories(fields:SearchFieldDef[], choices:CategoryChoice[]|null):SearchFieldDef[] {
  if(choices===null)return fields;
  return fields.map(field=>field.key==='categoryId'?{...field,options:choices}:field);
}
export function quickCategoryValues(choices:CategoryChoice[]):string[] {
  return QUICK_CATEGORY_NAMES.flatMap(name=>choices.filter(choice=>choice.label===name).map(choice=>choice.value));
}
