import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
export async function loadInquiryConfig(file){
 const source=resolve(file),config=JSON.parse(await readFile(source,'utf8'));
 for(const field of ['root','belloProfileDir','profileDir','playwrightModulePath']){
  if(typeof config[field]!=='string'||!config[field])throw Error('INVALID_CONFIG');
  const expanded=config[field].replaceAll('${LOCALAPPDATA}',process.env.LOCALAPPDATA??'');
  if(config[field].includes('${LOCALAPPDATA}')&&!process.env.LOCALAPPDATA)throw Error('LOCALAPPDATA_REQUIRED');
  config[field]=resolve(dirname(source),expanded);
 }
 return config;
}
