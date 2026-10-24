import 'server-only';
import {S3Client,GetObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import outputs from '../../amplify_outputs.json';
import type {InventoryListRow} from './queries';
import { effectiveListThumbnailKey, type InventoryImageRecord } from './imageTypes';
const s3=new S3Client({region:outputs.storage.aws_region});
const cache=new Map<string,{url:string;until:number}>();
/** Internal only: callers supply inventory rows read through the authenticated data boundary.
 * URL signing is local; do not make each browser obtain separate Cognito storage credentials. */
export async function signInventoryListKey(key:string):Promise<string|null>{
 if(!key.startsWith('inventory/')||key.includes('..'))return null;
 const hit=cache.get(key);if(hit&&hit.until>Date.now())return hit.url;
 try{
  const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:outputs.storage.bucket_name,Key:key,ResponseCacheControl:'private, max-age=900'}),{expiresIn:900});
  if(cache.size>=1000)cache.delete(cache.keys().next().value!);
  cache.set(key,{url,until:Date.now()+5*60*1000});return url;
 }catch{return null;}
}
export async function withListImageUrls<T extends InventoryListRow>(rows:T[]):Promise<T[]>{
 return Promise.all(rows.map(async row=>({...row,mainImageSignedUrl:row.mainImageThumbnailKey?await signInventoryListKey(row.mainImageThumbnailKey):null})));
}

/** Only previews from an already-authorized inventory record. Originals stay on demand. */
export async function signInventoryPreviews(images: InventoryImageRecord[]): Promise<Record<string, string>> {
 const keys = [...new Set(images.flatMap(image => [effectiveListThumbnailKey(image), image.mediumKey].filter((key): key is string => Boolean(key))))];
 const signed = await Promise.all(keys.map(async key => [key, await signInventoryListKey(key)] as const));
 return Object.fromEntries(signed.filter((entry): entry is readonly [string, string] => entry[1] !== null));
}

