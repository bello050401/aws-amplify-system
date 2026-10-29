import {useEffect,useState} from 'react';
import type {ListPhotoCache} from '../domain/listPhotoCache';
import type {InventoryItem} from '../domain/inventory';
import {downloadVisiblePhoto,storablePhoto} from '../runtime/listPhotoCache.web';

/** Object URLs exist only while a rendered row is mounted; no 1,000-image decoded-memory cache. */
export function useListPhoto(cache:ListPhotoCache|undefined,item:InventoryItem){
 const [local,setLocal]=useState<{key:string;url:string}|null>(null);
 const key=item.id+':'+item.updatedAt;
 useEffect(()=>{
  if(!cache)return;
  let live=true,pending=false,rerun=false,failed=false,url:string|null=null;
  const controller=new AbortController();
  const update=async()=>{
   if(!live||url||(failed&&!cache.has(item)))return;
   if(pending){rerun=true;return;}
   pending=true;
   try{
    let blob=await cache.read(item).catch(()=>null);
    if(!live)return;
    if(!blob&&item.thumbnailUrl){
     const finish=cache.beginVisible();
     try{blob=await downloadVisiblePhoto(item.thumbnailUrl,controller.signal);if(live&&await storablePhoto(blob))void cache.rememberVisible(item,blob);}
     finally{finish();}
    }
    if(!live)return;
    url=blob?URL.createObjectURL(blob):null;setLocal(url?{key,url}:null);
   }catch{failed=true;/* Retry from a later cached copy or remount, not on every background photo. */}
   finally{pending=false;if(rerun&&live&&!url){rerun=false;void update();}}
  };
  const unsubscribe=cache.subscribe(()=>{void update();});void update();
  return()=>{live=false;controller.abort();unsubscribe();if(url)URL.revokeObjectURL(url);};
 },[cache,key,item.thumbnailUrl]);
 return cache?(local?.key===key?local.url:null):item.thumbnailUrl;
}
