import React,{useEffect,useRef,useState} from 'react';
import type {InventoryGallery,InventoryItem,InventoryPhoto} from '../domain/inventory';
import type {ListPhotoCache} from '../domain/listPhotoCache';
import {useListPhoto} from './useListPhoto';
import {InventoryPhotoViewer} from './InventoryPhotoViewer';
import {reusableThumbnail} from '../domain/thumbnailFreshness';
import {initialPreviewPhotos} from '../domain/photoPreview';

function orderedPhotos(photos:InventoryPhoto[]) {
  return [...photos].sort((a,b)=>Number(b.primary)-Number(a.primary)||Number(a.type==='DAMAGE')-Number(b.type==='DAMAGE'));
}

/** A temporary gallery; never changes list selection, inventory, or the persistent photo cache. */
export function InventoryPhotoPreview({item,offline,cache,loadPhotos,loadDetail,onClose}:{
  item:InventoryItem; offline:boolean; cache?:ListPhotoCache;
  loadPhotos?:(id:string)=>Promise<InventoryGallery>;loadDetail?:(id:string)=>Promise<InventoryItem>;onClose:()=>void;
}) {
  const thumbnail=useListPhoto(cache,item);
  const initial=()=>initialPreviewPhotos(item.photos,thumbnail);
  const [photos,setPhotos]=useState<InventoryPhoto[]>(initial),[index,setIndex]=useState(0);
  const [loading,setLoading]=useState(false),[notice,setNotice]=useState(''),[attempt,setAttempt]=useState(0);
  const currentPhotoId=useRef(photos[index]?.id);currentPhotoId.current=photos[index]?.id;
  const galleryResolved=useRef(false);
  useEffect(()=>{
    // The local thumbnail may become available after the modal was mounted.
    if(thumbnail&&!galleryResolved.current)setPhotos(current=>current.length?current:initialPreviewPhotos([],thumbnail));
  },[thumbnail]);
  useEffect(()=>{
    let active=true;
    if(offline){setLoading(false);setNotice('圏外のため、取得済みの写真を表示しています。');return;}
    if(!attempt&&item.photosComplete&&item.photos?.length&&item.photos.every(photo=>reusableThumbnail(photo.fullUrl??photo.url))){setLoading(false);return;}
    if(!loadPhotos&&!loadDetail){setNotice(item.photos?.length||item.thumbnailUrl?'一覧用の写真を表示しています。':'写真を取得できません。');return;}
    setLoading(true);setNotice('');
    void (async()=>{
      const gallery=loadPhotos?await loadPhotos(item.id):await loadDetail!(item.id);
      if(!active)return;
      if(gallery.id!==item.id)throw Error('Photo identity mismatch');
      galleryResolved.current=Boolean(gallery.photosComplete);
      const next=orderedPhotos(gallery.photos??[]);
      if(next.length||gallery.photosComplete){const samePhoto=next.findIndex(photo=>photo.id===currentPhotoId.current);setPhotos(next);setIndex(samePhoto<0?0:samePhoto);}
      if(!gallery.photosComplete)setNotice('一部の写真を取得できませんでした。');
    })().catch(()=>{if(active)setNotice('大きい写真を取得できませんでした。通信を確認して再取得してください。');})
      .finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[item,offline,loadPhotos,loadDetail,attempt]);
  return <InventoryPhotoViewer photos={photos} index={index} onIndexChange={setIndex} onClose={onClose} title={item.name}
    loading={loading} notice={notice} onRetry={!offline&&!loading&&(loadPhotos||loadDetail)?()=>setAttempt(n=>n+1):undefined}/>;
}
