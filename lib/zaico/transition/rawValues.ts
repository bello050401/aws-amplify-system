export const RAW_VALUES='__belloZaicoUnconvertedValues';
export function unconvertedZaicoValues(custom:Record<string,unknown>|null|undefined){
  const raw=custom?.[RAW_VALUES];
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return [];
  return Object.entries(raw).flatMap(([field,value])=>{
    if(!value||typeof value!=='object'||!('name' in value)||!('value' in value)||
      typeof value.name!=='string'||typeof value.value!=='string')return [];
    return [{field,name:value.name,value:value.value}];
  });
}
