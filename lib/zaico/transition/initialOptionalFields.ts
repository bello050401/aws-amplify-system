import {mapZaicoOptionalAttributes,resolveZaicoAttributeTarget,ZAICO_ATTRIBUTE_MAP} from '../../inventory/zaicoMapping';
import type {ZaicoOptionalAttribute} from '../client';

export class InitialMappingError extends Error {
  constructor(public readonly warnings: string[]) {
    super('ZAICOの追加項目に変換できない値があります。変更前に確認してください。');
  }
}

/**
 * A verified full optional_attributes response is authoritative even for empty
 * values. Ordinary incremental/legacy imports keep their established behavior.
 * Unknown BELLO-only keys are deliberately not included in these clear maps.
 */
export function initialOptionalFields(attributes:ZaicoOptionalAttribute[]|null|undefined){
  if(!Array.isArray(attributes))throw Error('ZAICOの追加項目を確認できないため、初回同期を停止しました。');
  // Normalize numeric presentation only. Never normalize product prose or infer
  // that "-", "数点", or an Excel-like number is an empty value or a date.
  const normalized=attributes.map(attribute=>{
    const target=resolveZaicoAttributeTarget(attribute.name);
    return target.kind!=='unmapped'&&target.valueType==='number'&&typeof attribute.value==='string'
      ? {...attribute,value:attribute.value.normalize('NFKC')} : attribute;
  });
  const mapped=mapZaicoOptionalAttributes(normalized,true);
  const invalid=mapped.warnings.filter(w=>/変換|解釈|不正/.test(w));
  if(invalid.length)throw new InitialMappingError(invalid);
  const coreFields:Record<string,unknown>={},extendedFields:Record<string,unknown>={},customFields:Record<string,unknown>={};
  for(const target of Object.values(ZAICO_ATTRIBUTE_MAP)){
    if(target.kind==='coreField')coreFields[target.field]=null;
    else if(target.kind==='extendedField')extendedFields[target.field]=null;
    else if(target.kind==='customField')customFields[target.fieldKey]=null;
  }
  return {...mapped,coreFields:{...coreFields,...mapped.coreFields},extendedFields:{...extendedFields,...mapped.extendedFields},customFields:{...customFields,...mapped.customFields}};
}
