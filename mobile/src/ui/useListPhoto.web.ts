import {useEffect,useState} from 'react';
import type {ListPhotoCache} from '../domain/listPhotoCache';
import type {InventoryItem} from '../domain/inventory';

/** Object URLs exist only while a rendered row is mounted; no 1,000-image decoded-memory cache. */
export function useListPhoto(cache:ListPhotoCache|undefined,item:InventoryItem){
 const [local,setLocal]=useState<{key:string;url:string}|null>(null);
 const key=item.id+':'+item.updatedAt;
 useEffect(()=>{
  if(!cache)return;
  let live=true,sequence=0,url:string|null=null;
  const update=async()=>{
   const current=++sequence;
   if(url&&cache.has(item))return;
   const blob=await cache.read(item).catch(()=>null);
   if(!live||current!==sequence)return;
   if(url)URL.revokeObjectURL(url);
   url=blob?URL.createObjectURL(blob):null;setLocal(url?{key,url}:null);
  };
  const unsubscribe=cache.subscribe(()=>{void update();});void update();
  return()=>{live=false;sequence++;unsubscribe();if(url)URL.revokeObjectURL(url);};
 },[cache,key]);
 return local?.key===key?local.url:item.thumbnailUrl;
}
