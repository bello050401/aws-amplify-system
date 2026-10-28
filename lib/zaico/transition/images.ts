import {createHash} from 'node:crypto';
import type {Row} from './mapping';

// Procurement photos already live in BELLO. Fill an empty ZAICO main photo
// once; do not overwrite an operator's photo or resurrect a removed photo.
export function procurementPhoto(row:Row|undefined){
 if(!row||row.deletedAt)return undefined;
 let fields:Row;try{fields=typeof row.customFields==='string'?JSON.parse(row.customFields):row.customFields;}catch{return undefined;}
 if(!fields?.__restageImport&&!fields?.__yahooPurchaseImport)return undefined;
 const images=(Array.isArray(row.images)?row.images:[]).filter((i:Row)=>!i.deletedAt&&i.type==='NORMAL'&&i.storageKey&&i.sourceSystem!=='ZAICO');
 const image=images.find((i:Row)=>i.isPrimary)||images[0];
 if(!image)return undefined;
 const fingerprint=createHash('sha256').update(JSON.stringify([image.sourceBucket??'',image.storageKey,image.originalHash??''])).digest('hex');
 return {image,fingerprint};
}
export function needsPhoto(row:Row|undefined,state:Row|undefined){
 const photo=procurementPhoto(row);
 return !!photo&&!state?.remote?.item_image?.url&&state?.imageExport?.fingerprint!==photo.fingerprint;
}
