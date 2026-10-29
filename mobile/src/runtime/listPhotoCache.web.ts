import {ListPhotoCache,LIST_PHOTO_SINGLE_BYTES} from '../domain/listPhotoCache';
import {listPhotoRepository} from './listPhotoRepository.web';
import type {InventoryThumbnail} from '../domain/inventory';

export async function downloadListPhoto(url:string,signal:AbortSignal):Promise<Blob>{
 const parsed=new URL(url);
 // Copies may have opaque inventory keys. Byte and pixel limits also verify those copies.
 if(parsed.protocol!=='https:'||!parsed.hostname.endsWith('.amazonaws.com')||!(/^\/inventory\//.test(parsed.pathname)||/\/photo-batches\/[^/]+\/thumbnail\//.test(parsed.pathname)))throw Error('PHOTO_NOT_THUMBNAIL');
 const controller=new AbortController(),abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});
 if(signal.aborted)abort();const timeout=setTimeout(abort,15000);
 try{
 const response=await fetch(url,{signal:controller.signal,credentials:'omit',cache:'no-store',redirect:'error'});
 if(!response.ok||!response.headers.get('content-type')?.toLowerCase().startsWith('image/jpeg')){await response.body?.cancel();throw Error('PHOTO_DOWNLOAD');}
 if(Number(response.headers.get('content-length'))>LIST_PHOTO_SINGLE_BYTES){await response.body?.cancel();throw Error('PHOTO_TOO_LARGE');}
 const reader=response.body?.getReader();if(!reader)throw Error('PHOTO_DOWNLOAD');
 let total=0;const chunks:Uint8Array<ArrayBuffer>[]=[];
 try{while(true){const part=await reader.read();if(part.done)break;total+=part.value.byteLength;if(total>LIST_PHOTO_SINGLE_BYTES)throw Error('PHOTO_TOO_LARGE');chunks.push(new Uint8Array(part.value));}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const blob=new Blob(chunks,{type:'image/jpeg'});
 if(!smallJpeg(new Uint8Array(await blob.arrayBuffer())))throw Error('PHOTO_NOT_THUMBNAIL');
 return blob;
 }finally{clearTimeout(timeout);signal.removeEventListener('abort',abort);}
}
// Read dimensions from the JPEG header without decoding 1,000 images into RAM.
export function smallJpeg(b:Uint8Array):boolean{
 if(b[0]!==255||b[1]!==216)return false;
 for(let i=2;i+8<b.length;){
  if(b[i++]!==255)return false;while(b[i]===255)i++;
  const marker=b[i++];if(marker===217||marker===218)return false;
  if(marker===1||(marker>=208&&marker<=215))continue;
  const length=(b[i]<<8)|b[i+1];if(length<2||i+length>b.length)return false;
  if([192,193,194].includes(marker)){const h=(b[i+3]<<8)|b[i+4],w=(b[i+5]<<8)|b[i+6];return w>0&&h>0&&w<=320&&h<=320;}
  i+=length;
 }return false;
}
export function createListPhotoCache(owner:string,load:(ids:string[])=>Promise<InventoryThumbnail[]>){return new ListPhotoCache(listPhotoRepository,owner,load,downloadListPhoto);}
